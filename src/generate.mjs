import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { OPENAI_MODEL, MAX_RETRIES, RETRY_DELAY_MS, OUTPUT_DIR, UNSPLASH_API_URL } from './config.mjs';
import { buildGenerationPrompt, buildImageSearchQuery } from './prompts.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitiseSlug(slug) {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

// Detect problematic patterns the prompt forbids: direct quotes or
// named-individual attributions from non-government sources, and named
// schools. Returns an array of offending snippets (empty if clean).
function findQuoteOrNamedSchoolViolations(body) {
  const violations = [];

  // Non-government roles — any named individual carrying one of these
  // titles is forbidden (they represent schools, private education
  // groups, or unnamed source-person constructs).
  const NON_GOV_ROLE = String.raw`(?:principal|headteacher|headmaster|headmistress|head\s+of(?:\s+school)?|deputy\s+head|vice\s+principal|founder|co-?founder|director|managing\s+director|executive\s+director|chair(?:person|man|woman)?|president|vice-?president|ceo|coo|cfo|cto|chief\s+(?:executive|operating|financial|academic|education)\s+officer|group\s+(?:ceo|head)|board\s+member|trustee|spokesperson\s+for\s+[A-Z]|owner\s+of\s+[A-Z]|partner\s+at\s+[A-Z]|consultant)`;

  // Patterns that indicate non-government human attribution.
  // Each pattern captures a short window around the match for logging.
  const patterns = [
    // "FirstName LastName, <role> of/at <Something>"  — catches
    //   "Poonam Bhojani, CEO of Innoventures Education"
    //   "Lisa Johnson, principal of the American Academy for Girls"
    //   "X, founder and director of Y"
    new RegExp(
      String.raw`\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\s*,\s*(?:[a-z]+\s+and\s+)?${NON_GOV_ROLE}\b[^.]*`,
      'gi',
    ),
    // "<role> of <Named Thing>"  — "CEO of Innoventures", "principal of Jebel Ali School"
    new RegExp(String.raw`\b${NON_GOV_ROLE}\s+(?:of|at)\s+[A-Z][^.]*`, 'gi'),
    // "one principal said" / "a headteacher told" / "school officials indicated"
    /\b(?:one|a|another|some)\s+(?:principal|headteacher|headmaster|teacher|parent|student|school\s+official|ceo|director|founder)s?\b[^.]*?\b(?:said|told|noted|explained|indicated|stated|confirmed|added|urged)\b[^.]*/gi,
    // "Principals / CEOs / Directors … said/indicated/noted" (plural without gov attribution)
    /\b(?:Principals|Headteachers|Headmasters|CEOs|Directors|Founders)\b[^.]*?\b(?:said|told|noted|explained|indicated|stated|confirmed|have\s+indicated)\b[^.]*/gi,
    // "parents told / students said / teachers said"
    /\b(?:parents|students|teachers|headteachers|headmasters|principals)\b[^.]*?\b(?:told\s+reporters|said|spoke\s+to)\b[^.]*/gi,
    // "X said" where X is a capitalised surname-like token not clearly
    // government (catches "Bhojani said", "Johnson said", "Barrett stated")
    /(?<!KHDA\s)(?<!ADEK\s)(?<!SPEA\s)(?<!MOE\s)(?<!Ministry\s)(?<!Authority\s)(?<!Cabinet\s)(?<!Sheikh\s)\b[A-Z][a-z]{3,}\s+(?:said|told|noted|stated|added|urged|explained|indicated|confirmed|highlighted|reiterated)\b[^.]*/g,
    // Named private UAE education groups — mentioning these by name
    // implies a quote or attribution from them.
    /\b(?:GEMS\s+Education|Innoventures\s+Education|Taaleem|Aldar\s+Education|Bloom\s+Education|Esol\s+Education|Beacon\s+Education|Nord\s+Anglia|Cognita|Inspired\s+Education|International\s+Schools\s+Partnership|ISP)\b[^.]*/g,
  ];

  const GOV_CONTEXT = /(khda|adek|spea|moe|ministry|minister|authority|cabinet|sheikh|government|media\s+office|spokesperson|ambassador|national\s+emergency|crisis\s+management|wam\b)/i;

  for (const re of patterns) {
    for (const match of body.matchAll(re)) {
      const matchText = match[0];
      const matchStart = match.index ?? 0;

      // Skip if the match itself OR a generous window before it contains a
      // government-context marker. 120 chars of preceding body is enough to
      // capture "The Ministry of Education confirmed…" type constructions.
      const windowBefore = body.slice(Math.max(0, matchStart - 120), matchStart);
      if (GOV_CONTEXT.test(matchText) || GOV_CONTEXT.test(windowBefore)) continue;

      const snippet = matchText.trim().slice(0, 160);
      if (!violations.includes(snippet)) violations.push(snippet);
    }
  }

  return violations;
}

// Determine if the article is primarily about nurseries
function isNurseryArticle(text) {
  const nurseryCount = (text.match(/\bnursery\b|\bnurseries\b/gi) || []).length;
  const schoolCount = (text.match(/\bschool\b|\bschools\b/gi) || []).length;
  return nurseryCount > schoolCount;
}

// Link the first mention of each UAE city to the appropriate site page.
// Skips heading lines (#, ##, ###, etc.) so we never inject markdown links
// into headings — links in headings break some downstream renderers and
// serve no SEO purpose.
function addCityLinks(text) {
  const siteUrl = process.env.SITE_URL;
  if (!siteUrl) return text; // skip linking if no site URL configured

  // Split into frontmatter and body
  const secondDelimiter = text.indexOf('---', 3);
  if (secondDelimiter === -1) return text;

  const frontmatter = text.slice(0, secondDelimiter + 3);
  const body = text.slice(secondDelimiter + 3);

  const isNursery = isNurseryArticle(body);
  const basePath = isNursery ? '/nurseries' : '/schools';
  const cities = [
    { name: 'Abu Dhabi', param: 'Abu%20Dhabi' },
    { name: 'Dubai', param: 'Dubai' },
    { name: 'Sharjah', param: 'Sharjah' },
  ];

  const lines = body.split('\n');
  const isHeading = (line) => /^\s*#{1,6}\s/.test(line);

  // Replace the first occurrence of `pattern` in any non-heading line,
  // ignoring text that sits inside an existing markdown link `[...](...)`
  // (so we never match "schools" inside `/schools?location=Dubai` etc.)
  // or inside an inline code span.
  const MD_LINK_OR_CODE = /\[[^\]]*\]\([^)]*\)|`[^`]*`/g;
  const applyFirstMatch = (pattern, makeLink) => {
    for (let i = 0; i < lines.length; i++) {
      if (isHeading(lines[i])) continue;

      // Mask out existing links / code spans, search in the plain remainder.
      const masked = lines[i].replace(MD_LINK_OR_CODE, (m) => '\0'.repeat(m.length));
      const match = pattern.exec(masked);
      if (!match) continue;

      const start = match.index;
      const end = start + match[0].length;
      const replacement = lines[i].slice(start, end).replace(pattern, makeLink);
      lines[i] = lines[i].slice(0, start) + replacement + lines[i].slice(end);
      return;
    }
  };

  for (const city of cities) {
    const url = `${siteUrl}${basePath}?location=${city.param}`;
    const re = new RegExp(`\\b(${city.name})\\b`);
    applyFirstMatch(re, `[$1](${url})`);
  }

  if (!isNursery) {
    applyFirstMatch(/\b(schools)\b/i, `[$1](${siteUrl}/schools)`);
  }

  applyFirstMatch(
    /\b(nurseries|nursery)\b/i,
    `[$1](${siteUrl}/nurseries)`,
  );

  return frontmatter + lines.join('\n');
}

// Scan the generated body for common "invented specifics" — concrete
// items (fire drills, lockdown procedures, specific training types) that
// the model often adds to pad an article when the source is thin. We
// flag a specific claim only when it does NOT appear anywhere in any
// of the source bodies. This is intentionally narrow: we want to catch
// hallucinated specifics, not every paraphrase.
function findInventedSpecifics(body, sources) {
  const haystack = sources
    .map((s) => (s.fullArticle || '').toLowerCase())
    .join(' ');
  if (!haystack.trim()) return [];

  // Specific items the model has been observed to invent. Each entry is
  // a phrase/pattern that we check in the generated body AND in the
  // combined source bodies. If the body mentions it but no source does,
  // it's a likely invention.
  const specifics = [
    'fire drill', 'fire drills',
    'lockdown procedure', 'lockdown procedures',
    'first aid training',
    'cpr training',
    'shelter-in-place', 'shelter in place',
    'reverse evacuation',
    'earthquake drill',
    'cybersecurity training',
    'counselling sessions',
    'psychological first aid',
    'bomb threat',
  ];

  const bodyLower = body.toLowerCase();
  const flagged = [];
  for (const phrase of specifics) {
    if (bodyLower.includes(phrase) && !haystack.includes(phrase)) {
      flagged.push(phrase);
    }
  }
  return flagged;
}

function extractSlugFromFrontmatter(text) {
  const match = text.match(/^slug:\s*"?([^"\n]+)"?/m);
  if (match) return sanitiseSlug(match[1]);
  return null;
}

async function fetchUnsplashImage(query) {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  if (!accessKey) {
    console.warn('  Warning: No UNSPLASH_ACCESS_KEY set, skipping image.');
    return null;
  }

  try {
    const params = new URLSearchParams({
      query,
      per_page: '10',
      orientation: 'landscape',
      content_filter: 'high',
    });
    const res = await fetch(`${UNSPLASH_API_URL}?${params}`, {
      headers: { Authorization: `Client-ID ${accessKey}` },
    });

    if (!res.ok) {
      console.warn(`  Warning: Unsplash API returned ${res.status}, skipping image.`);
      return null;
    }

    const data = await res.json();
    if (data.results && data.results.length > 0) {
      // Pick the most-liked photo (community-validated quality)
      const sorted = data.results.sort((a, b) => (b.likes || 0) - (a.likes || 0));
      const photo = sorted[0];
      return {
        url: photo.urls.full,
        alt: photo.alt_description || query,
        credit: photo.user.name,
        creditUrl: photo.user.links.html,
      };
    }
  } catch (err) {
    console.warn(`  Warning: Unsplash fetch failed: ${err.message}`);
  }

  return null;
}

async function getImageSearchQuery(openai, title) {
  try {
    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: buildImageSearchQuery(title) }],
      temperature: 0,
    });
    return response.choices[0].message.content.trim();
  } catch {
    return 'school children';
  }
}

export async function generatePost(openai, articles) {
  const title = articles[0].title;
  const basePrompt = buildGenerationPrompt(articles);
  let lastViolations = []; // violations from previous attempt, used to reprimand the model

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // On retry after a validation failure, prepend a corrective block that
      // names the exact violations from the previous attempt so the model
      // knows precisely what to avoid this time.
      let prompt = basePrompt;
      if (lastViolations.length > 0) {
        const violationList = lastViolations
          .slice(0, 8)
          .map((v) => `  - "${v}"`)
          .join('\n');
        const reprimand = `YOUR PREVIOUS ATTEMPT WAS REJECTED. It contained these forbidden attributions or named individuals:

${violationList}

Regenerate the article from scratch. Do NOT include ANY of the above phrases or anything resembling them. Remove every reference to named principals, headteachers, school staff, parents, teachers, students, or any non-government person. Do NOT name any school. Paraphrase the underlying facts with no attribution to individuals. Direct quotes are permitted ONLY from KHDA, ADEK, SPEA, MOE, UAE Government Media Office, a Sheikh, a minister, or a named authority spokesperson — and only when publicly released.

==========================================================================

`;
        prompt = reprimand + basePrompt;
      }

      const response = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
      });

      let text = response.choices[0].message.content.trim();

      // Strip outer markdown fencing if present
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/i, '').trim();
      }

      // Validate frontmatter
      if (!text.startsWith('---')) {
        console.warn('  Warning: Response missing frontmatter, retrying...');
        if (attempt === MAX_RETRIES) return null;
        continue;
      }

      const secondDelimiter = text.indexOf('---', 3);
      if (secondDelimiter === -1) {
        console.warn('  Warning: Response has incomplete frontmatter, retrying...');
        if (attempt === MAX_RETRIES) return null;
        continue;
      }

      // Hard validation: reject articles that quote or name school staff
      // or unnamed "officials/parents". The prompt forbids this, but the
      // model still sometimes slips through — validator is the safety net.
      const bodyOnly = text.slice(secondDelimiter + 3);
      const violations = findQuoteOrNamedSchoolViolations(bodyOnly);
      const invented = findInventedSpecifics(bodyOnly, articles);
      const allIssues = [
        ...violations,
        ...invented.map(
          (p) =>
            `Invented specific "${p}" — not present in any source body.`,
        ),
      ];
      if (allIssues.length > 0) {
        console.warn(`  Warning: Generated article failed validation:`);
        for (const v of allIssues.slice(0, 8)) console.warn(`    - ${v}`);
        if (attempt === MAX_RETRIES) {
          console.warn(`  Giving up after ${MAX_RETRIES} attempts — no article will be published.`);
          return null;
        }
        console.warn(`  Retrying generation with corrective prompt (attempt ${attempt + 1}/${MAX_RETRIES})...`);
        lastViolations = allIssues; // fed back into the next attempt's prompt
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      lastViolations = []; // passed validation, clear any stale state

      // Extract slug for filename
      const slug = extractSlugFromFrontmatter(text) || 'untitled-post';
      const today = new Date().toISOString().split('T')[0];
      const filename = `${today}-${slug}.md`;

      // Fetch image from Unsplash
      const imageQuery = await getImageSearchQuery(openai, title);
      console.log(`  Searching Unsplash for: "${imageQuery}"`);
      const image = await fetchUnsplashImage(imageQuery);

      // Insert image metadata into frontmatter
      if (image) {
        const insertPoint = text.indexOf('---', 3);
        const frontmatter = text.slice(0, insertPoint);
        const rest = text.slice(insertPoint);
        text = `${frontmatter}imageUrl: "${image.url}"\nimageAlt: "${image.alt}"\nimageCredit: "${image.credit}"\nimageCreditUrl: "${image.creditUrl}"\n${rest}`;
        console.log(`  Image: "${image.alt}" by ${image.credit}`);
      }

      // Add city hyperlinks
      text = addCityLinks(text);

      // Write file
      const outputDir = fileURLToPath(OUTPUT_DIR);
      await mkdir(outputDir, { recursive: true });
      const filePath = join(outputDir, filename);
      await writeFile(filePath, text + '\n', 'utf-8');

      return { outputFile: `output/${filename}`, slug, title: title };
    } catch (err) {
      if (err.status === 429) {
        const delay = RETRY_DELAY_MS * attempt;
        console.warn(`  Rate limited. Waiting ${delay}ms before retry ${attempt}/${MAX_RETRIES}...`);
        await sleep(delay);
      } else if (attempt === MAX_RETRIES) {
        console.warn(`  Error generating post: ${err.message}`);
        return null;
      } else {
        const delay = RETRY_DELAY_MS * attempt;
        console.warn(`  API error, retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  return null;
}

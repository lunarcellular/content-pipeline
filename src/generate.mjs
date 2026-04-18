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
  const prompt = buildGenerationPrompt(articles);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
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

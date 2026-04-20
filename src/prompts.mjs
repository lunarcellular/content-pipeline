export function buildRelevancePrompt(title, summary) {
  return `You are a content relevance classifier for a UAE school directory website for parents.

Evaluate whether the following is a NEWS article about UAE K-12 education that parents would care about. We want factual news reporting — not opinion pieces, lifestyle articles, or personal essays.

RELEVANT:
- Official government announcements about UAE schools (KHDA, ADEK, SPEA, MOE)
- New school policies, regulations, or curriculum changes
- School fee changes or new fee frameworks
- Admission deadline announcements or enrollment policy changes
- New schools opening or closing in the UAE
- Exam results, inspection outcomes, or school rating changes
- Official education statistics or reports released by regulators
- Changes to the UAE academic year, school calendar, or term dates
- New education initiatives, programmes, or learning frameworks approved by UAE authorities
- News about early years education (nursery, KG) policies in the UAE

NOT RELEVANT (reject all of these):
- Opinion pieces, editorials, or personal essays about education
- Lifestyle or feature articles (e.g. "silver linings of homeschooling")
- General parenting advice or homeschooling tips
- Technology/app news (even if children use the product)
- University or higher education news
- Education news from outside the UAE
- Individual school promotional content
- Charity campaigns, donations, or humanitarian appeals (even if they mention children)
- Celebratory or awareness days (e.g. World Teachers' Day) unless they include a concrete policy announcement

If the article reports on something an education authority DID or APPROVED, it is relevant. If it is just commentary or celebration, it is not.

Article title: ${title}
Article summary: ${summary}

Respond with ONLY a JSON object, no markdown fencing:
{"relevant": true/false, "reason": "one sentence explanation"}`;
}

export function buildGenerationPrompt(articles) {
  const today = new Date().toISOString().split('T')[0];

  // Separate tweets from article content so they don't get lost
  const allTweets = [];
  const sourceSections = articles.map((a, i) => {
    let articleContent = a.fullArticle || '';
    // Extract tweets section and store separately
    if (articleContent.includes('--- EMBEDDED OFFICIAL TWEETS ---')) {
      const [body, tweetSection] = articleContent.split('--- EMBEDDED OFFICIAL TWEETS ---');
      articleContent = body.trim();
      const tweetMatches = tweetSection.match(/\[EMBEDDED TWEET[^\]]*\]: "[^"]*" \(https?:\/\/[^)]+\)/g);
      if (tweetMatches) allTweets.push(...tweetMatches);
    }
    if (!articleContent) return null; // Skip articles without full content
    const content = `Full Article Content:\n${articleContent}`;
    return `SOURCE ${i + 1} (${a.sourceName}):
Title: ${a.title}
${content}
URL: ${a.link}`;
  }).filter(Boolean).join('\n\n---\n\n');

  // Build tweet instruction if we found any
  let tweetInstruction = '';
  if (allTweets.length > 0) {
    // Filter to only recent tweets (last 48 hours) using Twitter snowflake ID
    // Twitter IDs encode timestamp: (id >> 22) + 1288834974657 = unix ms
    const twoDaysAgo = Date.now() - 48 * 60 * 60 * 1000;
    const recentTweets = allTweets.filter(t => {
      const idMatch = t.match(/status\/(\d+)/);
      if (!idMatch) return false;
      const tweetId = BigInt(idMatch[1]);
      const tweetTimestamp = Number(tweetId >> 22n) + 1288834974657;
      return tweetTimestamp >= twoDaysAgo;
    });

    if (recentTweets.length > 0) {
      // Pick the best recent tweet (prefer KHDA, ADEK, MOE over generic)
      const priorityOrder = ['KHDA', 'ADEK', 'MOE', 'وزارة التربية'];
      let bestTweet = recentTweets[0];
      for (const keyword of priorityOrder) {
        const match = recentTweets.find(t => t.includes(keyword));
        if (match) { bestTweet = match; break; }
      }
      const urlMatch = bestTweet.match(/\((https?:\/\/[^)]+)\)/);
      const authorMatch = bestTweet.match(/by @([^\]]+)\]/);
      const tweetAuthor = authorMatch ? authorMatch[1] : '';
      // Extract the Twitter handle from the URL (e.g. twitter.com/UAEmediaoffice/status/...)
      const handleMatch = urlMatch?.[1]?.match(/(?:twitter\.com|x\.com)\/([^/]+)\/status/);
      const tweetHandle = handleMatch ? `@${handleMatch[1]}` : tweetAuthor;

      if (urlMatch) {
        tweetInstruction = `\n\nIMPORTANT — EMBED THIS TWEET IN THE ARTICLE:
You MUST include this official tweet somewhere in the article body after the opening paragraphs:
<blockquote class="twitter-tweet"><a href="${urlMatch[1]}"></a></blockquote>
The tweet is from ${tweetHandle}. Introduce it accurately, e.g. "The Ministry of Education confirmed on X:" or "KHDA announced on X:" — use whatever matches ${tweetHandle}.`;
      }
    }
  }

  return `You are a senior education journalist writing for a premium UAE school directory website.

You have ${articles.length} source article(s) about the same topic from different news outlets. Read ALL of them and write ONE comprehensive blog post that combines the best facts, figures, and details from every source. Do not miss important details that appear in only one source.

==========================================================================
ABSOLUTE RULES — VIOLATING ANY OF THESE MAKES THE ARTICLE UNPUBLISHABLE:

1. NEVER NAME ANY SCHOOL. Not in headings, not in body, not in quotes,
   not in examples. Zero exceptions. Refer to schools generically:
   "a Dubai school", "several British-curriculum schools", "one
   school in Sharjah". Even if every source article names schools,
   your output must not.

2. NEVER QUOTE A PRINCIPAL, HEADTEACHER, HEADMASTER, SCHOOL STAFF,
   TEACHER, PARENT, STUDENT, OR ANY NON-GOVERNMENT PERSON. Do not
   name them. Do not paraphrase their views with attribution like
   "one principal said…" or "a school official indicated…". If the
   source article is largely built on such quotes, paraphrase the
   FACTS only, with no attribution to individuals.

3. DIRECT QUOTES ARE ALLOWED ONLY FROM OFFICIAL UAE GOVERNMENT /
   REGULATORY SOURCES, publicly released:
   - KHDA, ADEK, SPEA, MOE (and their official spokespeople by title)
   - UAE Government Media Office, Cabinet, ministers, Sheikhs
   - Official government X/Twitter, Instagram, Facebook posts
   - Official press releases or government press briefings
   Attribute these explicitly, e.g. "KHDA said in a statement…",
   "The Ministry of Education confirmed on X…", "ADEK announced…".
   Never vague attributions like "officials said".

4. If no approved government quote exists in the sources, the article
   must contain ZERO direct quotes. Write it entirely in paraphrase.

BAD (would cause rejection):
  "Lisa Johnson, principal of the American Academy for Girls, said..."
  "Matthew Barrett, principal of Raffles International School..."
  "According to one headteacher in Dubai..."
  "'Standardised procedures are in place,' Bhojani said."
  "A parent told reporters..."
  "Principals across various schools have indicated..."

GOOD:
  "KHDA said in an official statement that schools must implement
   standardised shelter-in-place procedures."
  "Dubai schools are required to run safety drills on the first day
   of term, according to KHDA guidance."
  (No quotes at all, if no approved source exists.)
==========================================================================

Only write about facts, figures, dates, and details that are explicitly
stated in the source articles provided below. NEVER make up, assume, or
infer information that is not in the sources. If the sources don't
mention something, don't include it in the article.

UAE EDUCATION AUTHORITIES — do NOT mix these up:
- KHDA (Knowledge and Human Development Authority) = Dubai ONLY
- ADEK (Department of Education and Knowledge) = Abu Dhabi ONLY
- SPEA (Sharjah Private Education Authority) = Sharjah ONLY
- MOE (Ministry of Education) = Federal / all UAE
If a source article mentions KHDA, that applies to Dubai schools only — do NOT say KHDA governs Sharjah or Abu Dhabi. If a source mentions a rule in Sharjah, attribute it to SPEA or Sharjah authorities, NOT KHDA. Only attribute an authority to a city if the source explicitly states that connection.

Lead with the most important news, then provide context and analysis of what it means for parents.${tweetInstruction}

CRITICAL: NEVER invent or make up any tweet embed HTML. Only use tweet embeds if explicitly instructed above.

SOURCE ARTICLES:
${sourceSections}

WRITING STYLE (follow The New York Times approach):
1. Lead with the news — open with the most important fact in the first sentence
2. Use the inverted pyramid structure: most critical information first, supporting details after
3. Write in clear, authoritative prose — no fluff, no filler, no listicles
4. Include specific facts, figures, dates, and names of officials or regulators (but NEVER name specific schools)
5. Provide context — explain why this matters, what led to it, and what comes next
6. Use short paragraphs (2-3 sentences each)
7. Include analysis: what does this mean for parents choosing schools in the UAE?

TITLE RULES:
- IGNORE the source article's headline completely. It is often misleading or clickbait.
- Read the FULL ARTICLE CONTENT and base your title ONLY on what the article body actually says.
- If the article body talks about nurseries, the title must say nurseries — not "schools".
- If the article says "gradual" or "phased", don't write "reopening tomorrow".
- Be precise: use the exact terms, dates, and scope from the article content.
- NEVER exaggerate or broaden the scope beyond what the article actually reports.
- Bad: "UAE Schools Set for Phased Return" (article was about nurseries, not schools)
- Bad: "Will Schools Reopen? Here's What We Know" (clickbait question)
- Good: "UAE Nurseries to Reopen in Phases Starting This Week" (matches article content)
- Good: "KHDA Approves Home-Based Nursery Learning in Dubai" (specific, accurate)

CONTENT RULES:
1. Write in British English (e.g., "organised", "recognised", "programme", "centre")
2. NEVER mention any specific school by name. Refer to schools generically (e.g., "schools in Dubai", "several British-curriculum schools")
2a. QUOTES — extremely strict rule:
    - ONLY include direct quotes that come from an official UAE government or regulatory authority (KHDA, ADEK, SPEA, MOE, UAE Government Media Office, Cabinet, a Sheikh, a minister, a named authority spokesperson) AND that were publicly released — i.e. from an official statement, press release, official X/Twitter/Instagram/Facebook post, or government press briefing.
    - NEVER quote school principals, teachers, headteachers, school staff, parents, students, unnamed "sources", or anyone from a private school or private education group.
    - NEVER quote school press releases or school social media accounts — only government authority accounts.
    - If a source article's only quotes are from school staff or parents, write the piece WITHOUT any direct quotes. Paraphrase the facts instead.
    - When you do include an approved government quote, attribute it explicitly: 'KHDA said in an official statement…', 'The Ministry of Education confirmed on X…', 'ADEK announced…'. Never attribute a quote ambiguously ("officials said").
3. IMPORTANT — USE SPECIFIC CITY NAMES: When source articles mention Dubai, Abu Dhabi, or Sharjah, you MUST use those city names in your article. Do NOT generalise everything to "UAE". For example:
   - If KHDA (which is Dubai's authority) is mentioned, write "schools in Dubai" not "UAE schools"
   - If Sharjah schools have different rules, write "schools in Sharjah" not "some schools"
   - If Abu Dhabi has a separate policy, write "Abu Dhabi schools" not "certain schools"
   Every article should mention at least one specific city by name if the source articles do.
3. Tone: authoritative, clear, and direct — like reading a quality broadsheet. Not promotional, not condescending.
4. Do NOT include any promotional content, call-to-action, or links to any website. The article should be pure news. Do NOT hyperlink any city names — this will be handled separately.
5. NEVER direct parents to regulator websites or their school directories
6. Length: 600-900 words
7. The opening paragraph should work as a standalone summary of the news

SEO REQUIREMENTS (follow all of these):
1. Use a proper heading hierarchy: H2 for main sections in the body, H3 only for subsections within an H2 section. The H1 is in the frontmatter — do NOT use H1 (single #) in the article body. Start body sections with H2 (##).
2. Include the focus keyword naturally in: the first paragraph, at least one H2 subheading, and 2-3 more times throughout the body
3. Use 3-5 semantic keyword variations related to the focus keyword throughout the article (e.g. if focus keyword is "UAE school fees", also use "tuition costs in Dubai", "private school pricing", "education expenses UAE")
4. Add an estimated reading time in the frontmatter
6. Include 3-5 secondary keywords in the frontmatter
7. Write the meta description as a compelling summary that includes the focus keyword and encourages clicks

OUTPUT FORMAT (respond with ONLY this, no markdown fencing around the whole response):
---
title: "SEO-optimised title tag (50-60 characters, include focus keyword)"
metaDescription: "Compelling meta description (120-155 characters, include focus keyword)"
slug: "url-friendly-slug-with-keyword"
focusKeyword: "primary SEO keyword phrase"
secondaryKeywords: ["keyword 2", "keyword 3", "keyword 4"]
h1: "H1 heading (can differ from title tag, include focus keyword)"
readingTime: "X min read"
sourceUrls: [list the source URLs from all articles used]
generatedDate: "${today}"
category: "education"
schema: "NewsArticle"
---

[Blog post content in Markdown with H2/H3 subheadings, internal links, and keyword variations]`;
}

export function buildImageSearchQuery(title) {
  return `Pick ONE search term from this list that best matches the article topic. Only choose from this list:

- children classroom
- kids school uniform
- kindergarten kids
- children reading books
- school building exterior
- parent child school
- children tablet learning
- kids writing classroom
- young students backpack
- nursery toddlers playing
- children school playground
- kids raising hands classroom
- school hallway children

Article title: ${title}

Respond with ONLY the term, nothing else.`;
}

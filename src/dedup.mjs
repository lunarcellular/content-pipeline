import { readFile } from 'node:fs/promises';
import { OPENAI_MODEL } from './config.mjs';

// Group articles by topic — articles about the same event/announcement go in the same group
export async function groupArticlesByTopic(openai, articles) {
  if (articles.length <= 1) return [articles];

  const articleList = articles
    .map((a, i) => {
      let entry = `${i}: "${a.title}" (${a.sourceName})`;
      if (a.fullArticle) {
        entry += `\n   Content: ${a.fullArticle.slice(0, 800)}`;
      } else if (a.summary) {
        entry += `\n   Summary: ${a.summary.slice(0, 300)}`;
      }
      return entry;
    })
    .join('\n\n');

  const prompt = `You are a news editor. Group these UAE education articles by TOPIC. Articles about the same event, announcement, or policy change go in the same group — even if headlines differ, even if one says "nurseries" and another says "schools", even if one is Dubai-specific and another is UAE-wide.

Articles:
${articleList}

Respond with ONLY a JSON array of groups. Each group is an array of article indices.
Example: [[0, 2, 4], [1], [3, 5]]

No explanation, no markdown fencing. Just the JSON array.`;

  try {
    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    });

    const text = response.choices[0].message.content.trim()
      .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    const groups = JSON.parse(text);

    if (!Array.isArray(groups) || groups.length === 0) {
      console.warn('  Warning: Grouping returned invalid result, treating each as separate.');
      return articles.map((a) => [a]);
    }

    const result = groups.map((group) =>
      group.filter((i) => i >= 0 && i < articles.length).map((i) => articles[i])
    ).filter((g) => g.length > 0);

    console.log(`  Grouped ${articles.length} articles into ${result.length} topic(s):`);
    result.forEach((group, i) => {
      console.log(`    Topic ${i + 1}: ${group.map((a) => `"${a.title.slice(0, 50)}..."`).join(' + ')}`);
    });

    return result;
  } catch (err) {
    console.warn(`  Warning: Grouping failed (${err.message}), treating each as separate.`);
    return articles.map((a) => [a]);
  }
}

// Check if a topic overlaps with a previously generated post (cross-run dedup)
export async function isDuplicateOfExisting(openai, articles, manifest) {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const recentPosts = manifest.processedArticles.filter(
    (a) => a.relevant && a.outputFile && new Date(a.processedDate) >= cutoff
  );

  if (recentPosts.length === 0) return false;

  // Load the actual body of each existing post (dedup by outputFile — manifest
  // has one entry per source URL, so multiple entries can point at the same post).
  const seenFiles = new Set();
  const existingBlocks = [];
  for (const post of recentPosts) {
    if (seenFiles.has(post.outputFile)) continue;
    seenFiles.add(post.outputFile);
    try {
      const body = await readFile(
        new URL(post.outputFile, new URL('../', import.meta.url)),
        'utf-8',
      );
      existingBlocks.push(`EXISTING: "${post.title}"\n${body.slice(0, 1200)}`);
    } catch {
      existingBlocks.push(`EXISTING: "${post.title}"`);
    }
  }

  // Include every article in the new group, not just the first.
  const newBlock = articles
    .map(
      (a, i) =>
        `NEW ${i + 1}: "${a.title}"\n${(a.fullArticle || a.summary || '').slice(0, 600)}`,
    )
    .join('\n\n');

  const prompt = `You are deciding whether a NEW article should be published, or skipped because we already covered this story.

Skip (answer YES) ONLY if the NEW article adds NO substantially new facts, authority announcements, regulatory requirements, or named developments beyond what the EXISTING article already covers — i.e. it would just be restating the same story with a different headline.

Publish (answer NO) if ANY of the following are true:
- The NEW article introduces a new regulatory mandate, policy, or directive from an authority (KHDA, ADEK, SPEA, MOE, etc.) — even if it relates to the same ongoing situation
- The NEW article reports new named developments, numbers, dates, or specific actions (e.g. "safety drills rolled out", "X schools receive permits", "new fee cap announced")
- The NEW article is about a different angle with its own concrete new facts (e.g. the existing article covered the reopening decision; the new one reports a KHDA rule about what schools must offer)
- The NEW article reports a follow-up event that actually happened (not just context or anticipation)

Mere topical overlap is NOT enough to skip. Sub-angles with their own new facts should be published.

When in doubt, lean NO — we would rather publish a slightly overlapping article than miss a genuine new development.

${existingBlocks.join('\n\n---\n\n')}

---

${newBlock}

Answer on one line: "YES: <one-sentence reason>" or "NO: <one-sentence reason>".`;

  try {
    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    });
    const answer = response.choices[0].message.content.trim();
    console.log(`  Dedup: ${answer.slice(0, 200)}`);
    return answer.toUpperCase().startsWith('YES');
  } catch {
    return false;
  }
}

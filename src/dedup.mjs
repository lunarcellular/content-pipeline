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

Skip (answer YES) if the NEW article is ANY of:
- About the same event, announcement, or policy as an EXISTING article
- A follow-up, continuation, or sub-angle of an ongoing story already covered (e.g. if we wrote about "schools reopening April 20", then "safety drills ahead of April 20", "parent surveys ahead of reopening", or "bus arrangements for April 20" are all the SAME ongoing story — answer YES)
- Covering the same underlying facts with a different headline

Only publish (answer NO) if the NEW article introduces substantially new facts, a new authority announcement, or a genuinely different education topic.

When in doubt, lean YES — we would rather skip a marginal duplicate than publish overlapping content.

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

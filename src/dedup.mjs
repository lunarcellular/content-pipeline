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

  const recentTitles = recentPosts.map((a) => `- "${a.title}"`).join('\n');
  const newTitles = articles.map((a) => a.title).join(', ');
  const newContent = (articles[0].fullArticle || articles[0].summary || '').slice(0, 300);

  const prompt = `Is this NEW topic about the same thing as any EXISTING article?

NEW TOPIC: ${newTitles}
Content preview: ${newContent}

EXISTING ARTICLES (already published):
${recentTitles}

Same topic = same event, announcement, or policy change, even if worded differently.
Answer ONLY "YES" or "NO".`;

  try {
    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    });

    return response.choices[0].message.content.trim().toUpperCase().startsWith('YES');
  } catch {
    return false;
  }
}

import 'dotenv/config';
import OpenAI from 'openai';
import { RATE_LIMIT_DELAY_MS, EDUCATION_KEYWORDS, MIN_EDUCATION_CONTENT_CHARS } from './src/config.mjs';
import { fetchAllFeeds } from './src/feeds.mjs';
import { readManifest, isAlreadyProcessed, addEntry, writeManifest, hashUrl } from './src/manifest.mjs';
import { checkRelevance } from './src/relevance.mjs';
import { generatePost } from './src/generate.mjs';
import { fetchArticleContent, closeBrowser } from './src/scraper.mjs';
import { groupArticlesByTopic, isDuplicateOfExisting } from './src/dedup.mjs';
import { sendArticleEmail, sendSummaryEmail } from './src/email.mjs';
import { readFile } from 'node:fs/promises';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  // Optional --limit flag: `node run.mjs --limit 2`
  const limitIndex = process.argv.indexOf('--limit');
  const maxArticles = limitIndex !== -1 ? parseInt(process.argv[limitIndex + 1], 10) : Infinity;

  // Validate API key
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('\nError: OPENAI_API_KEY is not set.\n');
    console.error('Setup instructions:');
    console.error('  1. Go to https://platform.openai.com/api-keys');
    console.error('  2. Create an API key');
    console.error('  3. Copy .env.example to .env and paste your key\n');
    process.exit(1);
  }

  const openai = new OpenAI({ apiKey });

  console.log('\n=== Content Pipeline ===\n');

  // Read manifest
  const manifest = await readManifest();
  console.log(`Manifest has ${manifest.processedArticles.length} previously processed articles.\n`);

  // Fetch feeds
  const allItems = await fetchAllFeeds();
  if (allItems.length === 0) {
    console.log('\nNo articles found from any feed. Exiting.');
    return;
  }

  // Filter out already-processed articles
  // Filter out already-processed and old articles (only process last 24 hours)
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const unseenItems = allItems.filter((item) => {
    if (!item.link || isAlreadyProcessed(manifest, item.link)) return false;
    if (item.publishedDate) {
      const pubDate = new Date(item.publishedDate);
      if (!isNaN(pubDate.getTime()) && pubDate < oneDayAgo) return false;
    }
    return true;
  });

  // Pre-filter: only send articles to AI if they contain education-related keywords
  const keywordPattern = new RegExp(EDUCATION_KEYWORDS.join('|'), 'i');
  const newItems = unseenItems.filter((item) => {
    const text = `${item.title} ${item.summary}`;
    return keywordPattern.test(text);
  });

  const skippedCount = unseenItems.length - newItems.length;
  console.log(`\nFound ${allItems.length} total articles, ${unseenItems.length} recent & unseen, ${newItems.length} match education keywords (${skippedCount} skipped).\n`);

  if (newItems.length === 0) {
    console.log('No new articles to process. Exiting.');
    return;
  }

  // Apply limit if specified
  const itemsToCheck = newItems.slice(0, maxArticles);
  if (maxArticles !== Infinity) {
    console.log(`Limiting to ${maxArticles} articles (--limit flag).\n`);
  }

  // Step 1: Check relevance for all articles
  console.log('--- Step 1: Checking relevance ---\n');
  const relevantItems = [];

  for (const item of itemsToCheck) {
    console.log(`Checking: "${item.title}" (${item.sourceName})`);

    const relevance = await checkRelevance(openai, item.title, item.summary);
    console.log(`  Relevant: ${relevance.relevant} — ${relevance.reason}`);

    if (relevance.relevant) {
      relevantItems.push(item);
    } else {
      addEntry(manifest, {
        urlHash: hashUrl(item.link),
        title: item.title,
        sourceUrl: item.link,
        sourceName: item.sourceName,
        processedDate: new Date().toISOString(),
        relevant: false,
        outputFile: null,
      });
      await writeManifest(manifest);
    }

    await sleep(RATE_LIMIT_DELAY_MS);
  }

  console.log(`\n${relevantItems.length} relevant articles found.\n`);

  if (relevantItems.length === 0) {
    console.log('No relevant articles. Exiting.');
    console.log('\n=== Pipeline Complete ===');
    console.log(`Processed: ${itemsToCheck.length} articles`);
    console.log(`Relevant:  0`);
    console.log(`Generated: 0 blog posts\n`);
    return;
  }

  // Step 2: Fetch full article content for all relevant items
  console.log('--- Step 2: Fetching full articles ---\n');
  const articlesWithContent = [];
  // Case-insensitive keyword pattern reused for body-density scoring.
  const educationKeywordPattern = new RegExp(EDUCATION_KEYWORDS.join('|'), 'gi');
  for (const item of relevantItems) {
    console.log(`  Fetching: "${item.title}"`);
    const fullArticle = await fetchArticleContent(item.link, item.title);
    if (!fullArticle) {
      console.log(`    Skipped — could not fetch full article.`);
      addEntry(manifest, {
        urlHash: hashUrl(item.link),
        title: item.title,
        sourceUrl: item.link,
        sourceName: item.sourceName,
        processedDate: new Date().toISOString(),
        relevant: true,
        outputFile: null,
      });
      await writeManifest(manifest);
      continue;
    }

    // Measure how much of the body is actually about education.
    // Sum the characters of every sentence that contains at least one
    // education keyword. A war live-blog with one school line will
    // score ~120 chars; a real education article scores several thousand.
    const sentences = fullArticle.split(/(?<=[.!?])\s+/);
    const eduSentences = sentences.filter((s) => {
      educationKeywordPattern.lastIndex = 0;
      return educationKeywordPattern.test(s);
    });
    const eduChars = eduSentences.reduce((n, s) => n + s.length, 0);

    if (eduChars < MIN_EDUCATION_CONTENT_CHARS) {
      console.log(
        `    Skipped — only ${eduChars} chars of education-relevant content ` +
        `(need >= ${MIN_EDUCATION_CONTENT_CHARS}). Source body is likely off-topic.`,
      );
      addEntry(manifest, {
        urlHash: hashUrl(item.link),
        title: item.title,
        sourceUrl: item.link,
        sourceName: item.sourceName,
        processedDate: new Date().toISOString(),
        relevant: true,
        outputFile: null,
      });
      await writeManifest(manifest);
      continue;
    }

    item.fullArticle = fullArticle;
    articlesWithContent.push(item);
    console.log(`    Got ${fullArticle.length} characters (${eduChars} education-relevant).`);
  }

  // Replace relevantItems with only those that have full content
  const relevantWithContent = articlesWithContent;
  console.log(`\n${relevantWithContent.length} articles with full content (${relevantItems.length - relevantWithContent.length} skipped).\n`);

  if (relevantWithContent.length === 0) {
    console.log('No articles with full content. Exiting.');
    console.log('\n=== Pipeline Complete ===');
    console.log(`Processed: ${itemsToCheck.length} articles`);
    console.log(`Relevant:  ${relevantItems.length}`);
    console.log(`With content: 0`);
    console.log(`Generated: 0 blog posts\n`);
    return;
  }

  // Step 3: Group articles by topic
  console.log('\n--- Step 3: Grouping articles by topic ---\n');
  const topicGroups = await groupArticlesByTopic(openai, relevantWithContent);

  // Step 4: Generate one blog post per topic (combining all sources)
  console.log('\n--- Step 4: Generating blog posts ---\n');
  let generatedCount = 0;

  for (const group of topicGroups) {
    const topicTitle = group.map((a) => `"${a.title.slice(0, 50)}"`).join(' + ');
    console.log(`\nTopic: ${topicTitle}`);
    console.log(`  Sources: ${group.length} article(s)`);

    // Cross-run dedup: check if we already wrote about this topic recently
    const isDupe = await isDuplicateOfExisting(openai, group, manifest);
    if (isDupe) {
      console.log(`  Skipped: already wrote about this topic recently.`);
      for (const item of group) {
        addEntry(manifest, {
          urlHash: hashUrl(item.link),
          title: item.title,
          sourceUrl: item.link,
          sourceName: item.sourceName,
          processedDate: new Date().toISOString(),
          relevant: true,
          outputFile: null,
        });
      }
      await writeManifest(manifest);
      continue;
    }

    // Generate one blog post from all sources in this topic group
    console.log(`  Writing blog post from ${group.length} source(s)...`);
    const result = await generatePost(openai, group);

    if (result) {
      generatedCount++;
      console.log(`  Saved: ${result.outputFile}`);

      // Email the article
      try {
        const filePath = new URL(result.outputFile, new URL('./output/../', import.meta.url));
        const content = await readFile(filePath, 'utf-8');
        const sources = group.map((a) => `${a.sourceName}`).join(', ');
        await sendArticleEmail({ content, sources });
      } catch (err) {
        console.warn(`  Warning: Could not email article: ${err.message}`);
      }

      for (const item of group) {
        addEntry(manifest, {
          urlHash: hashUrl(item.link),
          title: item.title,
          sourceUrl: item.link,
          sourceName: item.sourceName,
          processedDate: new Date().toISOString(),
          relevant: true,
          outputFile: result.outputFile,
        });
      }
    } else {
      console.warn(`  Failed to generate post, skipping.`);
      for (const item of group) {
        addEntry(manifest, {
          urlHash: hashUrl(item.link),
          title: item.title,
          sourceUrl: item.link,
          sourceName: item.sourceName,
          processedDate: new Date().toISOString(),
          relevant: true,
          outputFile: null,
        });
      }
    }

    await writeManifest(manifest);
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  // Summary
  console.log('\n=== Pipeline Complete ===');
  console.log(`Processed: ${itemsToCheck.length} articles`);
  console.log(`Relevant:  ${relevantItems.length}`);
  console.log(`Topics:    ${topicGroups.length}`);
  console.log(`Generated: ${generatedCount} blog posts`);
  console.log('');

  // Send summary email
  await sendSummaryEmail({
    processed: itemsToCheck.length,
    relevant: relevantItems.length,
    topics: topicGroups.length,
    generated: generatedCount,
    feeds: 6,
  });
}

main()
  .catch((err) => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  })
  .finally(() => closeBrowser());

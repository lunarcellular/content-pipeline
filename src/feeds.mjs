import Parser from 'rss-parser';
import { FEEDS } from './config.mjs';

const parser = new Parser({
  timeout: 10000,
  headers: {
    'User-Agent': 'Content-Pipeline/1.0',
  },
});

export async function fetchAllFeeds() {
  const allItems = [];
  let feedsSucceeded = 0;

  for (const feed of FEEDS) {
    try {
      console.log(`Fetching: ${feed.name}...`);
      const result = await parser.parseURL(feed.url);

      for (const item of result.items) {
        allItems.push({
          title: item.title || '',
          link: item.link || '',
          summary: (item.contentSnippet || item.content || '').slice(0, 500),
          publishedDate: item.pubDate || item.isoDate || '',
          sourceName: feed.name,
        });
      }

      console.log(`  Found ${result.items.length} articles from ${feed.name}`);
      feedsSucceeded++;
    } catch (err) {
      console.warn(`  Warning: Failed to fetch ${feed.name}: ${err.message}`);
    }
  }

  if (feedsSucceeded === 0) {
    console.warn('Warning: All feeds failed. Nothing to process.');
  }

  return allItems;
}

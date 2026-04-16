import puppeteer from 'puppeteer-core';
import * as cheerio from 'cheerio';

const PAGE_TIMEOUT = 30000;

// Education section pages for each news site
const EDUCATION_PAGES = {
  'gulfnews.com': 'https://gulfnews.com/uae/education',
  'khaleejtimes.com': 'https://www.khaleejtimes.com/education',
  'thenationalnews.com': 'https://www.thenationalnews.com/uae/education/',
};

let browser = null;

async function getBrowser() {
  if (!browser) {
    const executablePath = process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';

    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browser;
}

export async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

// For Google News links, find the actual article URL
async function findRealArticleUrl(title) {
  const cleanTitle = title
    .replace(/\s*-\s*(Gulf News|Khaleej Times|The National|وكالة وام).*$/i, '')
    .trim()
    .toLowerCase();

  let domain = 'gulfnews.com';
  if (title.includes('Khaleej Times')) domain = 'khaleejtimes.com';
  else if (title.includes('The National')) domain = 'thenationalnews.com';

  const educationPage = EDUCATION_PAGES[domain];
  if (!educationPage) return null;

  try {
    const b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    await page.goto(educationPage, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    const html = await page.content();
    await page.close();

    const $ = cheerio.load(html);
    const keywords = cleanTitle.split(/\s+/).filter(w => w.length > 3).slice(0, 5);
    let bestMatch = null;
    let bestScore = 0;

    $('a[href]').each((_, el) => {
      const linkText = $(el).text().trim().toLowerCase();
      const href = $(el).attr('href');
      if (!href || linkText.length < 20) return;
      const score = keywords.filter(kw => linkText.includes(kw)).length;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = href.startsWith('http') ? href : `https://${domain}${href}`;
      }
    });

    if (bestScore >= 3) return bestMatch;
  } catch {}

  return null;
}

// Extract tweet URLs from raw HTML metadata (works without JS rendering)
function findTweetUrls(html) {
  const urls = [];

  // Gulf News stores tweet URLs in JSON metadata: "tweet-url":"https:\u002F\u002Ftwitter.com\u002F..."
  const escapedMatches = html.match(/tweet-url["']:\s*["']https?:\\u002F\\u002F(twitter\.com|x\.com)[^"']+/g);
  if (escapedMatches) {
    for (const m of escapedMatches) {
      const url = m.replace(/tweet-url["']:\s*["']/, '').replace(/\\u002F/g, '/');
      urls.push(url);
    }
  }

  // Direct tweet URLs in href attributes
  const directMatches = html.match(/https?:\/\/(twitter\.com|x\.com)\/\w+\/status\/\d+/g);
  if (directMatches) {
    for (const url of directMatches) {
      if (!urls.includes(url)) urls.push(url);
    }
  }

  return urls;
}

// Fetch tweet content via Twitter's public oembed API (no API key needed)
async function fetchTweetContent(tweetUrl) {
  try {
    const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(tweetUrl)}&omit_script=true`;
    const res = await fetch(oembedUrl, { timeout: 10000 });
    if (!res.ok) return null;

    const data = await res.json();
    // Parse the HTML response to get clean text
    const $ = cheerio.load(data.html);
    const text = $('blockquote p').text().trim();
    const author = data.author_name || '';
    const authorUrl = data.author_url || '';

    return { text, author, authorUrl, url: tweetUrl };
  } catch {
    return null;
  }
}

function extractArticleText(html) {
  const $ = cheerio.load(html);

  $('script, style, nav, header, footer, aside, iframe, noscript').remove();
  $('.ad, .advertisement, .social-share, .related-articles, .comments, .newsletter-signup, .sidebar, .breadcrumb, [class*="promo"], [class*="banner"]').remove();

  const siteSelectors = [
    '.article-body', '.story-body-text', '[data-type="article-body"]',
    '.article-detail__body', '.article-body-content', '.articleBody',
    '.article__content', '[data-testid="article-body"]',
    '.news-details', '.article-content',
    'article .body', 'article .content', '.post-content', '.entry-content',
    'article p',
    'main p',
  ];

  for (const selector of siteSelectors) {
    const elements = $(selector);
    if (elements.length > 0) {
      const text = elements
        .map((_, el) => $(el).text().trim())
        .get()
        .filter((t) => t.length > 30)
        .join('\n\n')
        .trim();
      if (text.length > 200) return text;
    }
  }

  const fallback = $('p')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((t) => t.length > 40)
    .join('\n\n')
    .trim();

  return fallback.length > 200 ? fallback : null;
}

export async function fetchArticleContent(url, title) {
  try {
    let targetUrl = url;

    if (url.includes('news.google.com') && title) {
      console.log(`    Resolving Google News link...`);
      const realUrl = await findRealArticleUrl(title);
      if (realUrl) {
        targetUrl = realUrl;
        console.log(`    Found: ${targetUrl.split('?')[0]}`);
      } else {
        console.warn(`    Could not find real article URL, using summary only.`);
        return null;
      }
    }

    // Use Puppeteer to load the page
    const b = await getBrowser();
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font', 'media'].includes(type)) req.abort();
      else req.continue();
    });

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await page.waitForSelector('article, .article-body, .article-content, main p', { timeout: 10000 }).catch(() => {});

    const html = await page.content();
    await page.close();

    // Extract article text
    let text = extractArticleText(html);
    if (!text) {
      console.warn(`  Warning: Could not extract meaningful content, using summary only.`);
      return null;
    }

    // Find and fetch embedded tweets
    const tweetUrls = findTweetUrls(html);
    if (tweetUrls.length > 0) {
      console.log(`    Found ${tweetUrls.length} tweet embed(s), fetching content...`);
      const tweetTexts = [];

      for (const tweetUrl of tweetUrls) {
        const tweet = await fetchTweetContent(tweetUrl);
        if (tweet) {
          console.log(`      @${tweet.author}: "${tweet.text.slice(0, 80)}..."`);
          tweetTexts.push(`[EMBEDDED TWEET by @${tweet.author}]: "${tweet.text}" (${tweet.url})`);
        }
      }

      if (tweetTexts.length > 0) {
        text += '\n\n--- EMBEDDED OFFICIAL TWEETS ---\n' + tweetTexts.join('\n');
      }
    }

    // Truncate to ~5000 chars
    if (text.length > 5000) {
      text = text.slice(0, 5000) + '...';
    }

    return text;
  } catch (err) {
    console.warn(`  Warning: Failed to fetch article: ${err.message}`);
    return null;
  }
}

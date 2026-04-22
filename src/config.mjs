export const FEEDS = [
  { name: 'Gulf News', url: 'https://gulfnews.com/stories.rss' },
  { name: 'Gulf News Education (via Google News)', url: 'https://news.google.com/rss/search?q=site:gulfnews.com+education+school&hl=en-AE&gl=AE&ceid=AE:en' },
  { name: 'Gulf News Schools (via Google News)', url: 'https://news.google.com/rss/search?q=site:gulfnews.com+UAE+schools+students&hl=en-AE&gl=AE&ceid=AE:en' },
  { name: 'Gulf News KHDA (via Google News)', url: 'https://news.google.com/rss/search?q=site:gulfnews.com+KHDA+OR+ADEK+OR+nursery&hl=en-AE&gl=AE&ceid=AE:en' },
  { name: 'Khaleej Times', url: 'https://www.khaleejtimes.com/stories.rss' },
  { name: 'Khaleej Times UAE', url: 'https://www.khaleejtimes.com/api/v1/collections/uae.rss' },
  { name: 'Khaleej Times Education (via Google News)', url: 'https://news.google.com/rss/search?q=site:khaleejtimes.com+education+school&hl=en-AE&gl=AE&ceid=AE:en' },
  { name: 'Khaleej Times Schools (via Google News)', url: 'https://news.google.com/rss/search?q=site:khaleejtimes.com+UAE+schools+students&hl=en-AE&gl=AE&ceid=AE:en' },
  { name: 'The National', url: 'https://www.thenationalnews.com/arc/outboundfeeds/rss/?outputType=xml' },
  { name: 'WAM Education (via Google News)', url: 'https://news.google.com/rss/search?q=site:wam.ae+education+school+students&hl=en-AE&gl=AE&ceid=AE:en' },
];

export const OPENAI_MODEL = 'gpt-4o-mini';

export const OUTPUT_DIR = new URL('../output/', import.meta.url);
export const MANIFEST_PATH = new URL('../manifest.json', import.meta.url);

export const MAX_RETRIES = 3;
export const RETRY_DELAY_MS = 2000;
export const RATE_LIMIT_DELAY_MS = 1000;

export const UNSPLASH_API_URL = 'https://api.unsplash.com/search/photos';

// Minimum education-relevant body content to allow generation.
// Sources like war live-updates blogs have 4000+ chars of mostly
// unrelated content with one headline-level education mention.
// If the scraped body contains fewer than this many education-
// keyword-adjacent characters, the article is dropped before the
// generation stage.
export const MIN_EDUCATION_CONTENT_CHARS = 1500;

// Keywords used to pre-filter articles before sending to Gemini.
// Articles must contain at least one keyword in their title or summary.
export const EDUCATION_KEYWORDS = [
  'school', 'schools', 'education', 'student', 'students', 'teacher', 'teachers',
  'curriculum', 'KHDA', 'ADEK', 'SPEA', 'MOE', 'tuition', 'fees', 'admission',
  'admissions', 'enrolment', 'enrollment', 'classroom', 'exam', 'exams',
  'inspection', 'academic', 'kindergarten', 'nursery', 'K-12', 'IB', 'GCSE',
  'A-level', 'CBSE', 'IGCSE', 'British curriculum', 'American curriculum',
  'learning', 'pupil', 'pupils', 'campus', 'semester', 'term', 'school year',
  'parent', 'parents', 'child', 'children', 'edtech', 'e-learning',
  'school bus', 'canteen', 'uniform', 'school health', 'school safety',
  'junk food', 'school meals', 'school nutrition', 'school transport',
  'distance learning', 'remote learning', 'in-person learning', 'hybrid learning',
  'school reopening', 'back to school', 'school closure',
];

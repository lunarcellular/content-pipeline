import { readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MANIFEST_PATH } from './config.mjs';

const manifestPath = fileURLToPath(MANIFEST_PATH);

export function hashUrl(url) {
  return createHash('sha256').update(url).digest('hex');
}

export async function readManifest() {
  try {
    const data = await readFile(manifestPath, 'utf-8');
    return JSON.parse(data);
  } catch {
    console.warn('Warning: Could not read manifest, starting fresh.');
    return { processedArticles: [] };
  }
}

export function isAlreadyProcessed(manifest, articleLink) {
  const hash = hashUrl(articleLink);
  return manifest.processedArticles.some((a) => a.urlHash === hash);
}

export function addEntry(manifest, entry) {
  manifest.processedArticles.push(entry);
}

export async function writeManifest(manifest) {
  const tmpPath = manifestPath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  await rename(tmpPath, manifestPath);
}

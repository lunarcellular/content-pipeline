import { OPENAI_MODEL, MAX_RETRIES, RETRY_DELAY_MS } from './config.mjs';
import { buildRelevancePrompt } from './prompts.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function checkRelevance(openai, title, summary) {
  const prompt = buildRelevancePrompt(title, summary);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      });

      const text = response.choices[0].message.content.trim()
        .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

      try {
        return JSON.parse(text);
      } catch {
        console.warn(`  Warning: Could not parse relevance response, retrying...`);
        if (attempt === MAX_RETRIES) {
          return { relevant: false, reason: 'Failed to parse AI response' };
        }
      }
    } catch (err) {
      if (err.status === 429) {
        const delay = RETRY_DELAY_MS * attempt;
        console.warn(`  Rate limited. Waiting ${delay}ms before retry ${attempt}/${MAX_RETRIES}...`);
        await sleep(delay);
      } else if (attempt === MAX_RETRIES) {
        console.warn(`  Error checking relevance: ${err.message}`);
        return { relevant: false, reason: `API error: ${err.message}` };
      } else {
        const delay = RETRY_DELAY_MS * attempt;
        console.warn(`  API error, retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  return { relevant: false, reason: 'Max retries exceeded' };
}

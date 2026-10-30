import type { ZodType } from 'zod';

/** Small models sometimes wrap JSON in prose or fences; dig it out and validate. */
export function extractJson<T>(text: string, schema: ZodType<T>): T | null {
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1]);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  candidates.push(text);
  for (const c of candidates) {
    try {
      const parsed = schema.safeParse(JSON.parse(c));
      if (parsed.success) return parsed.data;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

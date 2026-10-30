import { OLLAMA_URL, EMBED_MODEL } from './config.js';

/** Embed texts with the local Ollama embedding model (EmbeddingGemma by default). */
export async function embed(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  const batch = 32;
  for (let i = 0; i < texts.length; i += batch) {
    const slice = texts.slice(i, i + batch);
    const res = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: slice, truncate: true }),
    });
    if (!res.ok) throw new Error(`ollama embed ${res.status}: ${await res.text()}`);
    const j = await res.json() as { embeddings: number[][] };
    out.push(...j.embeddings);
  }
  return out;
}

export async function embedOne(text: string): Promise<number[]> {
  return (await embed([text]))[0];
}

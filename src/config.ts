import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const OUT_DIR = path.join(ROOT, 'out');

export const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
export const CHAT_MODEL = process.env.ANCESTORS_MODEL ?? 'gemma3:4b';
export const EMBED_MODEL = process.env.ANCESTORS_EMBED ?? 'embeddinggemma';
export const EMBED_DIM = Number(process.env.ANCESTORS_EMBED_DIM ?? 768);
export const DB_URL = `file:${path.join(DATA_DIR, 'ancestors.db').split(path.sep).join('/')}`;
export const MAX_HUNKS = Number(process.env.ANCESTORS_MAX_HUNKS ?? 8);
export const TOP_K = Number(process.env.ANCESTORS_TOP_K ?? 6);

export function slugOf(repo: string) {
  return repo.replace('/', '__');
}

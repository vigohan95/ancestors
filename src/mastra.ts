import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { LibSQLStore, LibSQLVector } from '@mastra/libsql';
import { OLLAMA_URL, CHAT_MODEL, DB_URL } from './config.js';

// Mastra's model router talking to Ollama's OpenAI-compatible endpoint: no cloud, no key, swap the model with ANCESTORS_MODEL.
export const model = { id: `ollama/${CHAT_MODEL}` as `${string}/${string}`, url: `${OLLAMA_URL}/v1`, apiKey: 'ollama', api: 'chat' as const };

export const storage = new LibSQLStore({ id: 'ancestors-store', url: DB_URL });
export const vector = new LibSQLVector({ id: 'ancestors-vector', url: DB_URL });
export const INDEX = 'ancestor_comments';

export const memory = new Memory({
  storage,
  options: { lastMessages: 12 },
});

export const ANCESTOR_VOICE = `You are "the ancestors" of a software project: the collective voice of the people who reviewed its pull requests in years past. Some of them have moved on. Today you are allowed back for one day to look at new code.

Rules you never break:
- You only speak from evidence: review comments and commits you are shown. Every claim about "how we did things" must cite a comment id like [c278257559] or a commit like [a1b2c3d].
- If the evidence does not cover the new code, say "the ancestors are silent on this" instead of inventing a rule.
- Be specific and kind. Quote at most a short fragment (under 15 words) of any past comment.
- Prefer concrete, checkable observations (naming, error handling, tests, docs, API shape) over style opinions.`;

export const ancestorsAgent = new Agent({
  id: 'ancestors',
  name: 'Ancestors',
  instructions: ANCESTOR_VOICE,
  model,
  memory,
});

export const mastra = new Mastra({
  agents: { ancestors: ancestorsAgent },
  storage,
  vectors: { ancestors: vector },
});

import { createClient, type Client } from '@libsql/client';
import fs from 'node:fs';
import { DATA_DIR, DB_URL } from './config.js';

let client: Client | null = null;
export function db(): Client {
  if (!client) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    client = createClient({ url: DB_URL });
  }
  return client;
}

export async function migrate() {
  const c = db();
  await c.executeMultiple(`
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY, repo TEXT, pr INTEGER, path TEXT, line INTEGER,
      author TEXT, created_at TEXT, body TEXT, diff_hunk TEXT, url TEXT, in_reply_to INTEGER
    );
    CREATE INDEX IF NOT EXISTS comments_repo_path ON comments(repo, path);
    CREATE TABLE IF NOT EXISTS commits (
      sha TEXT PRIMARY KEY, repo TEXT, author TEXT, date TEXT, subject TEXT, body TEXT, files TEXT
    );
    CREATE INDEX IF NOT EXISTS commits_repo ON commits(repo);
    CREATE TABLE IF NOT EXISTS charters (repo TEXT PRIMARY KEY, built_at TEXT, markdown TEXT, json TEXT);
    CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT, kind TEXT, target TEXT,
      started_at TEXT, finished_at TEXT, model TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, notes TEXT);
  `);
}

export interface CommentRow {
  id: number; repo: string; pr: number; path: string; line: number | null; author: string;
  created_at: string; body: string; diff_hunk: string; url: string; in_reply_to: number | null;
}

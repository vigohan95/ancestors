import { db, type CommentRow } from './db.js';
import { embedOne } from './embed.js';
import { vector, INDEX } from './mastra.js';
import { TOP_K } from './config.js';

export interface Evidence extends CommentRow { score: number; }

/** Semantic search over past review comments, optionally boosted toward the same file. */
export async function retrieveComments(repo: string, query: string, path?: string, topK = TOP_K): Promise<Evidence[]> {
  const qv = await embedOne(query.slice(0, 2000));
  const hits = await vector.query({ indexName: INDEX, queryVector: qv, topK: topK * 4, filter: { repo } });
  if (!hits.length) return [];
  const ids = hits.map(h => Number(h.id));
  const rows = await db().execute({
    sql: `SELECT * FROM comments WHERE id IN (${ids.map(() => '?').join(',')})`, args: ids,
  });
  const byId = new Map<number, CommentRow>();
  for (const r of rows.rows) byId.set(Number(r.id), r as unknown as CommentRow);
  const scored: Evidence[] = [];
  for (const h of hits) {
    const row = byId.get(Number(h.id)); if (!row) continue;
    let score = h.score;
    if (path && row.path === path) score += 0.15;              // same file: the ancestors literally stood here
    else if (path && row.path && sameDir(row.path, path)) score += 0.05;
    scored.push({ ...row, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

function sameDir(a: string, b: string) {
  return a.split('/').slice(0, -1).join('/') === b.split('/').slice(0, -1).join('/');
}

export async function commitsForPath(repo: string, path: string, limit = 8) {
  const rows = await db().execute({
    sql: `SELECT sha, author, date, subject FROM commits WHERE repo = ? AND files LIKE ? ORDER BY date DESC LIMIT ?`,
    args: [repo, `%${path}%`, limit],
  });
  return rows.rows.map(r => ({ sha: String(r.sha), author: String(r.author), date: String(r.date), subject: String(r.subject) }));
}

export async function charterFor(repo: string): Promise<string | null> {
  const r = await db().execute({ sql: 'SELECT markdown FROM charters WHERE repo = ?', args: [repo] });
  return r.rows.length ? String(r.rows[0].markdown) : null;
}

export function fmtEvidence(e: Evidence[]) {
  return e.map(c => `[c${c.id}] ${c.author} on ${c.created_at.slice(0, 10)} in PR #${c.pr} (${c.path}):\n${c.body.trim().slice(0, 600)}`).join('\n\n');
}

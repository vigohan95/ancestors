import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { db, migrate } from './db.js';
import { embed } from './embed.js';
import { vector, INDEX, ancestorsAgent } from './mastra.js';
import { DATA_DIR, EMBED_DIM, slugOf } from './config.js';
import { extractJson } from './json.js';

interface RawComment {
  id: number; pull_request_url: string; path: string; line: number | null; original_line: number | null;
  diff_hunk: string; body: string; created_at: string; html_url: string; in_reply_to_id: number | null; user: string;
}

/** Fetch every PR review comment of a GitHub repo with the gh CLI (cached as JSONL). */
export function fetchComments(repo: string): RawComment[] {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, `${slugOf(repo)}_review_comments.jsonl`);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  }
  const all: RawComment[] = [];
  for (let page = 1; page < 200; page++) {
    const out = execFileSync('gh', ['api', `repos/${repo}/pulls/comments?per_page=100&sort=created&direction=asc&page=${page}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const arr = JSON.parse(out) as any[];
    for (const c of arr) {
      all.push({ id: c.id, pull_request_url: c.pull_request_url, path: c.path, line: c.line, original_line: c.original_line, diff_hunk: c.diff_hunk, body: c.body, created_at: c.created_at, html_url: c.html_url, in_reply_to_id: c.in_reply_to_id ?? null, user: c.user?.login ?? 'unknown' });
    }
    process.stdout.write(`\r  fetched ${all.length} comments`);
    if (arr.length < 100) break;
  }
  fs.writeFileSync(file, all.map(c => JSON.stringify(c)).join('\n') + '\n');
  process.stdout.write('\n');
  return all;
}

export interface CommitInfo { sha: string; author: string; date: string; subject: string; body: string; files: string[] }

/** Read commit history from a local clone (works fully offline / for private repos). */
export function readCommits(clonePath: string): CommitInfo[] {
  const RS = '\u001e';
  const US = '\u001f';
  const raw = execFileSync('git', ['-C', clonePath, 'log', '--no-merges', `--format=${RS}%H${US}%an${US}%aI${US}%s${US}%b${US}`, '--name-only'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const commits: CommitInfo[] = [];
  for (const chunk of raw.split(RS).slice(1)) {
    const parts = chunk.split(US);
    if (parts.length < 6) continue;
    const [sha, author, date, subject, body, filesRaw] = parts;
    const files = filesRaw.split('\n').map(s => s.trim()).filter(Boolean);
    commits.push({ sha, author, date, subject, body: body.trim().slice(0, 2000), files });
  }
  return commits;
}

export async function ingest(repo: string, clonePath?: string) {
  await migrate();
  const c = db();
  const t0 = Date.now();
  const comments = fetchComments(repo);
  console.log(`[ingest] ${comments.length} review comments for ${repo}`);
  await c.execute({ sql: 'DELETE FROM comments WHERE repo = ?', args: [repo] });
  const stmts = comments.map(x => ({
    sql: 'INSERT OR REPLACE INTO comments (id, repo, pr, path, line, author, created_at, body, diff_hunk, url, in_reply_to) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    args: [x.id, repo, Number(x.pull_request_url.split('/').pop()), x.path, x.line ?? x.original_line, x.user, x.created_at, x.body, (x.diff_hunk ?? '').slice(0, 1500), x.html_url, x.in_reply_to_id],
  }));
  for (let i = 0; i < stmts.length; i += 200) await c.batch(stmts.slice(i, i + 200), 'write');

  if (clonePath) {
    const commits = readCommits(clonePath);
    console.log(`[ingest] ${commits.length} commits from ${clonePath}`);
    await c.execute({ sql: 'DELETE FROM commits WHERE repo = ?', args: [repo] });
    const cs = commits.map(k => ({ sql: 'INSERT OR REPLACE INTO commits (sha, repo, author, date, subject, body, files) VALUES (?,?,?,?,?,?,?)', args: [k.sha, repo, k.author, k.date, k.subject, k.body, k.files.join('\n')] }));
    for (let i = 0; i < cs.length; i += 200) await c.batch(cs.slice(i, i + 200), 'write');
  }

  // Embeddings: what the ancestor said + where they said it.
  await vector.createIndex({ indexName: INDEX, dimension: EMBED_DIM, metric: 'cosine' }).catch(() => {});
  const substantive = comments.filter(x => x.body.trim().length >= 25);
  console.log(`[ingest] embedding ${substantive.length} substantive comments with EmbeddingGemma...`);
  const texts = substantive.map(x => `File: ${x.path}\nReviewer: ${x.user}\nComment: ${x.body.slice(0, 1200)}\nCode under review:\n${(x.diff_hunk ?? '').split('\n').slice(-6).join('\n')}`);
  const B = 64;
  for (let i = 0; i < texts.length; i += B) {
    const vecs = await embed(texts.slice(i, i + B));
    const slice = substantive.slice(i, i + B);
    await vector.upsert({ indexName: INDEX, vectors: vecs, ids: slice.map(x => String(x.id)), metadata: slice.map(x => ({ repo, path: x.path, author: x.user, year: x.created_at.slice(0, 4) })) });
    process.stdout.write(`\r  embedded ${Math.min(i + B, texts.length)}/${texts.length}`);
  }
  process.stdout.write('\n');
  console.log(`[ingest] done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await buildCharter(repo);
}

/** A Mastra workflow that distils the ancestors' recurring expectations into a short charter. */
const charterSchema = z.object({
  rules: z.array(z.object({ rule: z.string(), evidence: z.array(z.string()).describe('comment ids like c123') })).min(3).max(16),
});

const sampleStep = createStep({
  id: 'sample-voices',
  inputSchema: z.object({ repo: z.string() }),
  outputSchema: z.object({ repo: z.string(), sample: z.string(), n: z.number() }),
  execute: async ({ inputData }) => {
    // Stratified by year so no single era or reviewer dominates: up to 8 substantive top-level comments per year.
    const rows = await db().execute({
      sql: `SELECT id, author, created_at, path, body FROM comments WHERE repo = ? AND length(body) BETWEEN 80 AND 600 AND in_reply_to IS NULL ORDER BY created_at`,
      args: [inputData.repo],
    });
    const byYear = new Map<string, typeof rows.rows>();
    for (const r of rows.rows) { const y = String(r.created_at).slice(0, 4); if (!byYear.has(y)) byYear.set(y, []); byYear.get(y)!.push(r); }
    const picked: typeof rows.rows = [];
    for (const [, list] of [...byYear.entries()].sort()) {
      const step = Math.max(1, Math.floor(list.length / 8));
      for (let i = 0; i < list.length && picked.length < 44; i += step) picked.push(list[i]);
    }
    const sample = picked.map(r => `[c${r.id}] ${r.author} (${String(r.created_at).slice(0, 4)}, ${r.path}): ${String(r.body).replace(/\s+/g, ' ').slice(0, 260)}`).join('\n');
    return { repo: inputData.repo, sample, n: picked.length };
  },
});

const distilStep = createStep({
  id: 'distil-charter',
  inputSchema: z.object({ repo: z.string(), sample: z.string(), n: z.number() }),
  outputSchema: z.object({ repo: z.string(), markdown: z.string(), json: z.string() }),
  execute: async ({ inputData }) => {
    const prompt = `Below are ${inputData.n} review comments the maintainers of ${inputData.repo} left on pull requests over the years. Distil the 5-8 expectations they kept RETURNING to across different years and reviewers (API design, naming, tests, docs, error handling, compatibility, style). A rule only counts if at least two different comments support it; give those comment ids. Write each rule as a general expectation that a reviewer could apply to brand-new code (good: "Prefer explicit parameters over **kwargs in public signatures"; bad: "Pass trust_env in the request call"). Reply with JSON only, at most 8 rules: {"rules":[{"rule":"...","evidence":["c123","c456"]}]}\n\n${inputData.sample}`;
    const res = await ancestorsAgent.generate(prompt, { modelSettings: { maxOutputTokens: 2500, temperature: 0.2 } });
    const parsed = extractJson(res.text, charterSchema);
    if (!parsed) console.warn('[charter] could not parse model output, raw text follows: ' + res.text.slice(0, 1500));
    // Two witnesses or it does not count: a "rule" backed by a single comment is one person's opinion on one line.
    const sampleIds = new Set([...inputData.sample.matchAll(/\[(c\d+)\]/g)].map(m => m[1]));
    const rules = (parsed?.rules ?? [])
      .map(r => ({ rule: r.rule, evidence: [...new Set(r.evidence.map(e => e.replace(/[\[\]]/g, '')))].filter(e => sampleIds.has(e)) }))
      .filter(r => r.evidence.length >= 2);
    const dropped = (parsed?.rules.length ?? 0) - rules.length;
    const md = [
      '# What the ancestors kept asking for',
      '',
      `*Distilled by Gemma from ${inputData.n} comments spread across every year of review history; a rule only survives if at least two different comments back it (${dropped} single-witness candidates dropped).*`,
      '',
      ...(rules.length ? rules.map((r, i) => `${i + 1}. ${r.rule} (${r.evidence.map(e => `[${e}]`).join(' ')})`) : ['The ancestors did not repeat themselves enough in this sample for any rule to pass the two-witness test.']),
    ].join('\n');
    return { repo: inputData.repo, markdown: md, json: JSON.stringify(rules) };
  },
});

const saveStep = createStep({
  id: 'save-charter',
  inputSchema: z.object({ repo: z.string(), markdown: z.string(), json: z.string() }),
  outputSchema: z.object({ saved: z.boolean() }),
  execute: async ({ inputData }) => {
    await db().execute({ sql: 'INSERT OR REPLACE INTO charters (repo, built_at, markdown, json) VALUES (?,?,?,?)', args: [inputData.repo, new Date().toISOString(), inputData.markdown, inputData.json] });
    return { saved: true };
  },
});

export const charterWorkflow = createWorkflow({
  id: 'ancestor-charter',
  inputSchema: z.object({ repo: z.string() }),
  outputSchema: z.object({ saved: z.boolean() }),
}).then(sampleStep).then(distilStep).then(saveStep).commit();

export async function buildCharter(repo: string) {
  console.log("[charter] distilling the ancestors' recurring expectations (one local Gemma call)...");
  const run = await charterWorkflow.createRun();
  const result = await run.start({ inputData: { repo } });
  if (result.status !== 'success') throw new Error(`charter workflow ${result.status}: ${JSON.stringify((result as any).error ?? '')}`);
  const r = await db().execute({ sql: 'SELECT markdown FROM charters WHERE repo = ?', args: [repo] });
  console.log(String(r.rows[0]?.markdown ?? ''));
}

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { parseUnifiedDiff, rankHunks, type Hunk } from './diff.js';
import { retrieveComments, commitsForPath, charterFor, fmtEvidence, type Evidence } from './retrieve.js';
import { ancestorsAgent } from './mastra.js';
import { extractJson } from './json.js';
import { db, migrate } from './db.js';
import { CHAT_MODEL, MAX_HUNKS, OUT_DIR, slugOf } from './config.js';

const verdictSchema = z.object({
  verdict: z.enum(['note', 'ok', 'silent']),
  note: z.string(),
  citations: z.array(z.string()),
});

export interface HunkFinding {
  file: string; header: string; verdict: 'note' | 'ok' | 'silent'; note: string;
  citations: Evidence[]; ms: number;
}

export interface ReviewResult {
  repo: string; target: string; model: string; startedAt: string; finishedAt: string;
  hunksTotal: number; hunksReviewed: number; findings: HunkFinding[]; charter: string | null; markdown: string;
}

export function diffForPr(repo: string, pr: number): string {
  return execFileSync('gh', ['pr', 'diff', String(pr), '--repo', repo], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function prTitle(repo: string, pr: number): string {
  try {
    return execFileSync('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', 'title,author', '--jq', '"\\(.title) (by \\(.author.login))"'], { encoding: 'utf8' }).trim();
  } catch { return `PR #${pr}`; }
}

export async function reviewHunk(repo: string, hunk: Hunk, charter: string | null, onLog?: (s: string) => void): Promise<HunkFinding> {
  const t0 = Date.now();
  const query = `${hunk.file}\n${hunk.added.join('\n').slice(0, 1500)}\n${hunk.removed.join('\n').slice(0, 500)}`;
  const evidence = await retrieveComments(repo, query, hunk.file);
  const commits = await commitsForPath(repo, hunk.file, 5);
  const prompt = [
    `A new pull request touches ${hunk.file}. Here is the hunk:`,
    '```diff', hunk.text.slice(0, 3500), '```',
    commits.length ? `Recent commits to this file:\n${commits.map(c => `[${c.sha.slice(0, 7)}] ${c.date.slice(0, 10)} ${c.author}: ${c.subject}`).join('\n')}` : '',
    charter ? `The ancestors' charter:\n${charter}` : '',
    `Past review comments that may apply (the only evidence you may cite):\n${fmtEvidence(evidence) || '(none found)'}`,
    `Task: Does the new code honour or violate anything the ancestors asked for in the evidence? Reply with JSON only:\n{"verdict":"note"|"ok"|"silent","note":"<2-4 sentences, specific to the hunk, citing ids like [c123]>","citations":["c123"]}\n- "note": the evidence applies and the hunk should change or be double-checked.\n- "ok": the evidence applies and the hunk already honours it (say which rule).\n- "silent": the evidence does not really cover this hunk. Then note must be exactly "the ancestors are silent on this".\nNever cite an id that is not in the evidence list.`,
  ].filter(Boolean).join('\n\n');
  onLog?.(`  · ${hunk.file} ${hunk.header.slice(0, 30)} — ${evidence.length} voices retrieved`);
  const res = await ancestorsAgent.generate(prompt);
  const parsed = extractJson(res.text, verdictSchema);
  const allowed = new Map<string, Evidence>(evidence.map(e => [`c${e.id}`, e]));
  let verdict: HunkFinding['verdict'] = parsed?.verdict ?? 'silent';
  const cited = (parsed?.citations ?? []).map(c => allowed.get(c.replace(/[\[\]]/g, ''))).filter((x): x is Evidence => !!x);
  if (verdict !== 'silent' && cited.length === 0) verdict = 'silent'; // no verifiable citation → the ancestors stay silent
  const note = verdict === 'silent' ? 'the ancestors are silent on this' : (parsed?.note ?? res.text).trim();
  return { file: hunk.file, header: hunk.header, verdict, note, citations: cited, ms: Date.now() - t0 };
}

export async function reviewDiff(repo: string, target: string, diff: string, onLog?: (s: string) => void): Promise<ReviewResult> {
  await migrate();
  const startedAt = new Date().toISOString();
  const all = parseUnifiedDiff(diff);
  const hunks = rankHunks(all, MAX_HUNKS);
  const charter = await charterFor(repo);
  onLog?.(`[review] ${target}: ${all.length} hunks, reviewing the ${hunks.length} most substantive with ${CHAT_MODEL}`);
  const findings: HunkFinding[] = [];
  for (const h of hunks) findings.push(await reviewHunk(repo, h, charter, onLog));
  const finishedAt = new Date().toISOString();
  const result: ReviewResult = { repo, target, model: CHAT_MODEL, startedAt, finishedAt, hunksTotal: all.length, hunksReviewed: hunks.length, findings, charter, markdown: '' };
  result.markdown = renderMarkdown(result);
  await db().execute({ sql: 'INSERT INTO runs (repo, kind, target, started_at, finished_at, model, notes) VALUES (?,?,?,?,?,?,?)', args: [repo, 'review', target, startedAt, finishedAt, CHAT_MODEL, `${findings.filter(f => f.verdict === 'note').length} notes / ${findings.length} hunks`] });
  return result;
}

export function renderMarkdown(r: ReviewResult): string {
  const notes = r.findings.filter(f => f.verdict === 'note');
  const oks = r.findings.filter(f => f.verdict === 'ok');
  const silent = r.findings.filter(f => f.verdict === 'silent');
  const secs = ((+new Date(r.finishedAt) - +new Date(r.startedAt)) / 1000).toFixed(0);
  const lines: string[] = [];
  lines.push(`# The ancestors visited ${r.target}`);
  lines.push('');
  lines.push(`*${r.repo} · ${r.hunksReviewed} of ${r.hunksTotal} hunks reviewed · ${r.model} running locally · ${secs}s · ${notes.length} notes, ${oks.length} honoured, ${silent.length} silent*`);
  lines.push('');
  const block = (f: HunkFinding, emoji: string) => {
    lines.push(`### ${emoji} \`${f.file}\` ${f.header.split('@@')[1]?.trim() ?? ''}`);
    lines.push('');
    lines.push(f.note);
    if (f.citations.length) {
      lines.push('');
      for (const c of f.citations) {
        const quote = c.body.replace(/\s+/g, ' ').trim();
        const short = quote.split(' ').slice(0, 14).join(' ') + (quote.split(' ').length > 14 ? '…' : '');
        lines.push(`- [c${c.id}] **${c.author}**, ${c.created_at.slice(0, 10)}, [PR #${c.pr}](${c.url}) on \`${c.path}\`: “${short}”`);
      }
    }
    lines.push('');
  };
  if (notes.length) { lines.push('## They have something to say'); lines.push(''); notes.forEach(f => block(f, '🕯️')); }
  if (oks.length) { lines.push('## They nodded'); lines.push(''); oks.forEach(f => block(f, '🌼')); }
  if (silent.length) {
    lines.push('## They were silent on');
    lines.push('');
    for (const f of silent) lines.push(`- \`${f.file}\` ${f.header.split('@@')[1]?.trim() ?? ''}`);
    lines.push('');
  }
  if (r.charter) { lines.push('---'); lines.push(''); lines.push(r.charter.replace(/^# /m, '#### ')); }
  return lines.join('\n');
}

export function saveReport(r: ReviewResult): string {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = path.join(OUT_DIR, `${slugOf(r.repo)}__${r.target.replace(/[^a-z0-9]+/gi, '-')}`);
  fs.writeFileSync(base + '.md', r.markdown);
  fs.writeFileSync(base + '.json', JSON.stringify({ ...r, markdown: undefined }, null, 2));
  return base + '.md';
}

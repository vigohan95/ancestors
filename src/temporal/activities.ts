import { execFileSync } from 'node:child_process';
import { heartbeat, log } from '@temporalio/activity';
import { reviewDiff, diffForPr, prTitle, saveReport } from '../review.js';

export interface OpenPr { number: number; title: string; author: string; updatedAt: string }

/** List open pull requests (small, idempotent, safe to retry). */
export async function listOpenPrs(repo: string, limit: number): Promise<OpenPr[]> {
  const out = execFileSync('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(limit), '--json', 'number,title,author,updatedAt'], { encoding: 'utf8' });
  return (JSON.parse(out) as any[]).map(p => ({ number: p.number, title: p.title, author: p.author?.login ?? '?', updatedAt: p.updatedAt }));
}

/**
 * Review one PR. Long-running on CPU (minutes), so it heartbeats after every hunk; if the worker dies
 * mid-review Temporal retries the activity on the next worker instead of losing the whole haunting.
 */
export async function reviewPr(repo: string, pr: number): Promise<{ file: string; notes: number; hunks: number; seconds: number }> {
  const diff = diffForPr(repo, pr);
  const target = `PR #${pr} — ${prTitle(repo, pr)}`;
  const t0 = Date.now();
  const result = await reviewDiff(repo, target, diff, s => { log.info(s); heartbeat(s); }, pr);
  const file = saveReport(result);
  return { file, notes: result.findings.filter(f => f.verdict === 'note').length, hunks: result.hunksReviewed, seconds: Math.round((Date.now() - t0) / 1000) };
}

import { proxyActivities, log, sleep, defineQuery, setHandler } from '@temporalio/workflow';
import type * as activities from './activities.js';

const { listOpenPrs } = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: { initialInterval: '5s', maximumAttempts: 5 },
});

const { reviewPr } = proxyActivities<typeof activities>({
  startToCloseTimeout: '45 minutes',
  heartbeatTimeout: '2 minutes',          // CPU inference is slow; a dead worker is noticed within 2 min
  retry: { initialInterval: '10s', backoffCoefficient: 2, maximumAttempts: 4 },
});

export interface HauntInput { repo: string; limit?: number; rounds?: number; everyMinutes?: number }
export interface HauntState { round: number; reviewed: { pr: number; file: string; notes: number; hunks: number; seconds: number }[]; current?: number }

export const stateQuery = defineQuery<HauntState>('state');

/**
 * The haunting: visit a repository's open PRs, one by one, as many rounds as asked.
 * Durable by construction — kill the worker at any point and the next worker picks up the same PR.
 */
export async function hauntRepo(input: HauntInput): Promise<HauntState> {
  const state: HauntState = { round: 0, reviewed: [] };
  setHandler(stateQuery, () => state);
  const rounds = input.rounds ?? 1;
  const seen = new Set<string>();
  for (let round = 1; round <= rounds; round++) {
    state.round = round;
    const prs = await listOpenPrs(input.repo, input.limit ?? 3);
    for (const pr of prs) {
      const key = `${pr.number}@${pr.updatedAt}`;
      if (seen.has(key)) continue;          // unchanged since last round: let it rest
      state.current = pr.number;
      log.info(`the ancestors turn to PR #${pr.number}: ${pr.title}`);
      const r = await reviewPr(input.repo, pr.number);
      state.reviewed.push({ pr: pr.number, ...r });
      seen.add(key);
    }
    state.current = undefined;
    if (round < rounds) await sleep(`${input.everyMinutes ?? 60} minutes`);
  }
  return state;
}

// Minimal unified-diff parser: enough for `gh pr diff` / `git diff` output.
export interface Hunk {
  file: string;
  header: string;      // the @@ line
  added: string[];     // lines added (without '+')
  removed: string[];   // lines removed (without '-')
  context: string[];   // context lines
  text: string;        // full hunk text as it appeared
}

export function parseUnifiedDiff(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let file = '';
  let cur: Hunk | null = null;
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith('diff --git ')) {
      const m = raw.match(/ b\/(.+)$/);
      file = m ? m[1] : raw.slice(11);
      cur = null;
      continue;
    }
    if (raw.startsWith('+++ ') || raw.startsWith('--- ') || raw.startsWith('index ') || raw.startsWith('new file') || raw.startsWith('deleted file') || raw.startsWith('similarity') || raw.startsWith('rename ')) continue;
    if (raw.startsWith('@@')) {
      cur = { file, header: raw, added: [], removed: [], context: [], text: raw + '\n' };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    cur.text += raw + '\n';
    if (raw.startsWith('+')) cur.added.push(raw.slice(1));
    else if (raw.startsWith('-')) cur.removed.push(raw.slice(1));
    else if (raw.startsWith(' ')) cur.context.push(raw.slice(1));
  }
  return hunks;
}

/** Score hunks so we review the most substantive ones first (skip pure whitespace / lockfiles). */
export function rankHunks(hunks: Hunk[], max: number): Hunk[] {
  const skip = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|uv\.lock)$|\.min\.(js|css)$|\.svg$|\.png$/;
  return hunks
    .filter(h => !skip.test(h.file))
    .map(h => ({ h, score: h.added.filter(l => l.trim()).length * 2 + h.removed.filter(l => l.trim()).length }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(x => x.h);
}

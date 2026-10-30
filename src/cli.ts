#!/usr/bin/env node
import fs from 'node:fs';
import { ingest, buildCharter } from './ingest.js';
import { reviewDiff, diffForPr, prTitle, saveReport } from './review.js';
import { ask } from './ask.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const [, , cmd, repo, ...rest] = process.argv;

async function main() {
  if (!cmd || !repo) {
    console.log(`ancestors — let a repository's past reviewers look at today's code (local, open-weight).

  ancestors ingest <owner/repo> [--clone <path>]   fetch review history, embed it, distil the charter
  ancestors review <owner/repo> --pr <n>            review a pull request in the ancestors' voice
  ancestors review <owner/repo> --diff <file>       review a local unified diff (offline)
  ancestors ask    <owner/repo> "<question>" [--path <file>]
  ancestors charter <owner/repo>                    rebuild only the charter
`);
    return;
  }
  if (cmd === 'ingest') {
    await ingest(repo, arg('clone'));
  } else if (cmd === 'charter') {
    await buildCharter(repo);
  } else if (cmd === 'review') {
    const pr = arg('pr');
    const diffFile = arg('diff');
    let diff: string; let target: string;
    if (pr) { diff = diffForPr(repo, Number(pr)); target = `PR #${pr} — ${prTitle(repo, Number(pr))}`; }
    else if (diffFile) { diff = fs.readFileSync(diffFile, 'utf8'); target = diffFile; }
    else throw new Error('need --pr <n> or --diff <file>');
    const r = await reviewDiff(repo, target, diff, s => console.log(s), pr ? Number(pr) : undefined);
    const file = saveReport(r);
    console.log('\n' + r.markdown);
    console.log(`\n[saved] ${file}`);
  } else if (cmd === 'ask') {
    const q = rest.filter(x => !x.startsWith('--') && x !== arg('path')).join(' ');
    console.log(await ask(repo, q, arg('path'), arg('thread')));
  } else {
    throw new Error(`unknown command ${cmd}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

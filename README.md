# Ancestors

**Let a repository's past reviewers come back for one day.**

Every long-lived open-source project has people who used to review every pull request and then moved on. Their judgement did not leave with them: it is still sitting in thousands of review comments nobody reads. *Ancestors* pulls that history into a local vector store, distils what the reviewers kept asking for, and then reviews **today's** diffs in their collective voice, citing the exact comment and commit it relies on. If the ancestors never spoke about something, it says so instead of inventing a rule.

Everything runs on your machine with open weights: **Gemma 3** writes the review, **EmbeddingGemma** finds the voices, **Mastra** holds the agent, memory, vector store and the charter workflow, and **Temporal** makes a multi-hour "haunting" of a repository's open PRs survive crashes and restarts.

Built for the [DEV Hacktoberfest Open-Source AI Challenge: Week 4 — Ghost in the Machine](https://dev.to/challenges/hacktoberfest-week4-2026-10-26) (Día de los Muertos: the dead are allowed to visit, and they only speak about what they actually saw).

## What it does

```
$ npm run review -- encode/httpx --pr 3769

[review] PR #3769 — Ensure mounted transports are closed even if main transport raises (by bysiber):
         4 hunks, reviewing the 4 most substantive with gemma3:4b; only voices from before 2025-10-30 may speak
  · httpx/_client.py @@ -1267,10 +1267,12 @@ — 6 voices retrieved
  …

# The ancestors visited PR #3769 — Ensure mounted transports are closed even if main transport raises
encode/httpx · 4 of 4 hunks reviewed · gemma3:4b running locally · 114s · 2 notes, 0 honoured, 2 silent

## They have something to say
### 🕯️ httpx/_client.py -1267,10 +1267,12
… [c472953172] proposed a more robust approach with `self._is_closed` to prevent repeated calls to
`close()` when the client is already closed …
- [c477206186] florimondmanca, 2020-08-26, PR #1218 on httpx/_client.py
- [c472953172] lovelydinosaur, 2020-08-19, PR #1197 on httpx/_client.py: “We should put `self._is_closed = True` as the very first line…”

## They were silent on
- httpx/_client.py -1298,10 +1300,12
- httpx/_client.py -2013,7 +2019,9
```

Three honesty rules, enforced in code rather than in the prompt:

1. **Only the dead may speak** — a comment is an ancestor only if it is older than 12 months (`before` cutoff), and the PR under review never testifies about itself.
2. **No citation, no verdict** — a note that cites nothing from the retrieved evidence is downgraded to *"the ancestors are silent on this"*.
3. **Two witnesses or it does not count** — a charter rule survives only with two independent supporting comments.

Three commands:

| command | what happens |
|---|---|
| `npm run ingest -- owner/repo --clone ./path` | fetches every PR review comment with `gh`, reads `git log` from the clone, embeds the substantive comments with EmbeddingGemma into a LibSQL vector index, then runs a **Mastra workflow** (`sample-voices → distil-charter → save-charter`) that asks Gemma to write *the charter*: the 6–10 expectations the reviewers kept returning to, each with citations. |
| `npm run review -- owner/repo --pr N` (or `--diff file.patch`) | parses the diff, keeps the most substantive hunks, retrieves the nearest ancestor comments for each (same-file voices get a boost), and asks the **Mastra agent** for a verdict per hunk: `note`, `ok` or `silent`. A verdict without a verifiable citation is downgraded to *silent*. Writes `out/*.md` + `out/*.json`. |
| `npm run ask -- owner/repo "why does X look like this?" --path file` | question answering over comments + commits, with Mastra memory threads so you can keep asking. |

And the durable version:

```
# terminal 1: a Temporal dev server (single binary, no account)
temporal server start-dev
# terminal 2: the worker (one local model → one review at a time, heartbeats every hunk)
npm run worker
# terminal 3: start a haunting of the 3 most recent open PRs, 1 round
npm run haunt -- encode/httpx 3 1 -- --wait
```

Kill the worker in the middle of a review. Start it again. The workflow resumes on the same PR; nothing is lost and nothing is reviewed twice. The Temporal UI at `http://localhost:8233` shows every retry.

## Why open weights matter here

- **The code never leaves the machine.** Reviews of a private repository are exactly the thing you do not want to send to a hosted model. The whole pipeline (embeddings, retrieval, generation) runs against `localhost:11434`.
- **It is cheap enough to run on every PR, forever.** Thousands of comments embed in a few minutes on a laptop CPU; a review costs electricity, not tokens.
- **The voices are the project's own.** The point is not a smarter model; it is grounding a small model so hard in the project's history that it cannot help but sound like the project. Swap `ANCESTORS_MODEL=gemma3:12b` (or any Ollama model) and the ancestors get more articulate without a single code change.
- **No silent hallucination.** Every note must cite a comment id that was actually retrieved; otherwise the verdict is forced to *silent*. You can click every citation.

## Setup

```
# 1. Ollama with the two open-weight Gemma models
ollama pull gemma3:4b
ollama pull embeddinggemma

# 2. this repo
npm install
# 3. GitHub CLI logged in (only used to fetch public review comments / PR diffs)
gh auth status

# 4. ingest a project (example: encode/httpx, 2,690 review comments since 2019)
git clone --filter=blob:none https://github.com/encode/httpx data/clones/httpx
npm run ingest -- encode/httpx --clone data/clones/httpx

# 5. review an open PR
npm run review -- encode/httpx --pr 3688
```

Environment knobs: `ANCESTORS_MODEL` (default `gemma3:4b`), `ANCESTORS_EMBED` (default `embeddinggemma`), `ANCESTORS_MAX_HUNKS` (default 8), `ANCESTORS_TOP_K` (default 6), `OLLAMA_URL`, `TEMPORAL_ADDRESS`.

## How it is built

```
src/
  mastra.ts      Mastra instance: Agent "ancestors" (Gemma via Ollama), Memory + LibSQLStore, LibSQLVector
  ingest.ts      gh → comments, git log → commits, EmbeddingGemma → vectors, Mastra workflow → charter
  retrieve.ts    semantic search + same-file boost + commits for a path + charter lookup
  review.ts      diff → ranked hunks → per-hunk verdict with enforced citations → markdown/json report
  ask.ts         Q&A with memory threads
  diff.ts        small unified-diff parser
  temporal/      hauntRepo workflow, listOpenPrs/reviewPr activities with heartbeats, worker, starter
```

The model never gets a free-form "review this PR". It gets one hunk, the commits that touched that file, the charter, and the handful of past comments that are semantically closest to the change, and it has to answer in a strict shape. That is what lets a 4B model be useful: the retrieval does the remembering, the model does the reading.

## Honest limits

- Review comments are the ancestors' *words*, not their *reasons*; when a comment was a one-off nitpick the agent can over-generalise it. The charter step and the citation rule are the guard-rails, not a cure.
- Only GitHub PR review comments are ingested today (not issue comments, not review bodies without a line anchor).
- CPU inference with Gemma 3 4B takes roughly a minute per hunk on a Ryzen 5700G; that is why the Temporal path exists.

## License

MIT. Built during the Hacktoberfest Week 4 window (Oct 26–31, 2026) with help from Claude Code; every design decision, test run and number in the write-up is from real runs on this machine.

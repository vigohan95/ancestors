#!/usr/bin/env bash
# Crash-and-resume demo: start a haunting, kill the worker mid-review, start a new worker, watch Temporal finish the job.
set -u
REPO="${1:-encode/httpx}"; LIMIT="${2:-2}"
LOG="${DEMO_LOG_DIR:-./out}"; mkdir -p "$LOG"
echo "[demo] worker #1 starting"
npx tsx src/temporal/worker.ts > "$LOG/worker1.log" 2>&1 &
W1=$!
sleep 12
echo "[demo] starting haunting of $REPO (limit $LIMIT)"
npx tsx src/temporal/start.ts "$REPO" "$LIMIT" 1 --wait > "$LOG/haunt.log" 2>&1 &
H=$!
# wait for the first hunk to be reviewed, then pull the plug
until grep -q "voices retrieved" "$LOG/worker1.log"; do sleep 5; done
sleep 20
echo "[demo] $(date +%T) killing worker #1 (pid $W1) in the middle of a review"
taskkill //F //PID $W1 >/dev/null 2>&1 || kill -9 $W1
sleep 15
echo "[demo] $(date +%T) worker #2 starting"
npx tsx src/temporal/worker.ts > "$LOG/worker2.log" 2>&1 &
W2=$!
wait $H
echo "[demo] haunting finished"
WF=$(grep -o 'haunt-[^ ]*' "$LOG/haunt.log" | head -1)
echo "[demo] workflow $WF"
/d/income-engine/tools/temporal/temporal.exe workflow show -w "$WF" --address localhost:7233 2>/dev/null | grep -E "ActivityTaskScheduled|ActivityTaskStarted|ActivityTaskTimedOut|ActivityTaskFailed|ActivityTaskCompleted|WorkflowExecutionCompleted|attempt|Heartbeat" | head -40 > "$LOG/history.txt"
cat "$LOG/history.txt"
taskkill //F //PID $W2 >/dev/null 2>&1 || kill -9 $W2

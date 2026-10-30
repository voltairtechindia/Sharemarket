#!/usr/bin/env bash
# Append the call record to the `training-log` branch (scripts/training_log.js).
#
# Unlike live-data, this branch keeps its history and is never force-pushed:
# it is the long record the page's own files are trimmed from. Run by
# .github/workflows/history.yml after daily_call.js, inside the live-data
# concurrency group, so no two runs write it at once.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
if [ ! -f data/calls.json ]; then
  echo "no data/calls.json, nothing to log"
  exit 0
fi

git config user.name  "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

WORK="$(mktemp -d)"
WT="$WORK/log"
if git fetch -q origin training-log 2>/dev/null; then
  git worktree add -q --detach "$WT" FETCH_HEAD
else
  # First run: an orphan branch with nothing on it.
  git worktree add -q --detach "$WT"
  (
    cd "$WT"
    git checkout -q --orphan training-log
    git rm -rfq . >/dev/null 2>&1 || true
    rm -rf ./* 2>/dev/null || true
  )
fi

status=0
node scripts/training_log.js --out "$WT" || status=$?

[ "$status" -eq 0 ] && (
  cd "$WT"
  git add -A
  if git diff --cached --quiet; then
    echo "training log: nothing new"
    exit 0
  fi
  git commit -q -m "training log $(date -u +'%Y-%m-%d %H:%M UTC')"
  for attempt in 1 2 3; do
    if git push -q origin HEAD:refs/heads/training-log; then
      echo "training log pushed"
      exit 0
    fi
    echo "push refused, retrying after a rebase ($attempt)"
    git fetch -q origin training-log && git rebase -q FETCH_HEAD || exit 1
  done
  exit 1
) || status=$?
git worktree remove --force "$WT" >/dev/null 2>&1 || true
rm -rf "$WORK"
exit $status

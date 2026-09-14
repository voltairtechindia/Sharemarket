#!/usr/bin/env bash
# Commits data/ if anything changed. Retries on push races between the two workflows.
set -euo pipefail

LABEL="${1:-data}"

git config user.name "market-bot"
git config user.email "market-bot@users.noreply.github.com"

git add -A data/

if git diff --cached --quiet; then
  echo "nothing changed, skipping commit"
  exit 0
fi

git commit -m "${LABEL} $(date -u '+%Y-%m-%d %H:%M UTC')"

for attempt in 1 2 3 4 5; do
  if git push; then
    echo "pushed on attempt ${attempt}"
    exit 0
  fi
  echo "push rejected, rebasing and retrying (${attempt}/5)"
  git pull --rebase --autostash
  sleep $((attempt * 3))
done

echo "could not push after 5 attempts" >&2
exit 1

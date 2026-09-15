#!/usr/bin/env bash
# Force-push data/ to the `live-data` branch as a single orphan commit.
#
# Single orphan commit on purpose: this branch is rewritten up to five times
# every five minutes, and keeping history would add well over a thousand
# commits of churned JSON a day to the repository for no benefit. Nothing here
# is source - every file is reproducible by re-running the fetchers - so there
# is nothing to lose by discarding the old commit.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [ -z "$(ls -A data 2>/dev/null)" ]; then
  echo "data/ is empty, refusing to publish"
  exit 0
fi

git config user.name  "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

WORK="$(mktemp -d)"
cp -r data "$WORK/data"

cat > "$WORK/README.md" <<'EOF'
# live-data

Machine-generated. Rewritten by `.github/workflows/live-data.yml` roughly every
minute, as a single orphan commit each time, so this branch has no history.

The published page reads these files from `raw.githubusercontent.com`, which
serves them with CORS headers seconds after the push. GitHub Pages is not built
from this branch, so a data refresh never triggers a site rebuild and never
queues behind the Pages build limit.

Do not commit anything here by hand: the next run will discard it.
EOF

STAMP="$(date -u +'%Y-%m-%d %H:%M:%S UTC')"

git worktree add --detach "$WORK/wt" >/dev/null 2>&1 || true
(
  cd "$WORK/wt"
  git checkout --orphan live-data >/dev/null 2>&1
  git rm -rf . >/dev/null 2>&1 || true
  rm -rf ./* 2>/dev/null || true
  cp -r "$WORK/data" ./data
  cp "$WORK/README.md" ./README.md
  git add -A
  git commit -q -m "live data $STAMP"
  git push -q -f origin HEAD:live-data
)
git worktree remove --force "$WORK/wt" >/dev/null 2>&1 || true
rm -rf "$WORK"
echo "published live-data at $STAMP"

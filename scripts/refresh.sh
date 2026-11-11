#!/usr/bin/env bash
# Refresh the puzzle index and publish it. Safe to run repeatedly: silent when
# nothing changed, so it can drive a scheduled job without nightly noise.
set -euo pipefail

cd "$(dirname "$0")/.."

before_count=$(python3 -c "import json;print(json.load(open('data/puzzles.json'))['count'])" 2>/dev/null || echo 0)
before_latest=$(python3 -c "import json;print(json.load(open('data/puzzles.json'))['latest'])" 2>/dev/null || echo "")

python3 scripts/scrape.py >/tmp/ctc-scrape.log 2>&1 || {
  echo "scrape failed:"
  tail -5 /tmp/ctc-scrape.log
  exit 1
}

if git diff --quiet -- data/ && git diff --quiet --cached -- data/; then
  exit 0
fi

git add data/
git -c user.name="ctc-scraper" -c user.email="actions@users.noreply.github.com" \
    commit -qm "data: refresh puzzle index ($(date -u +%F))"
git push -q origin main

after_count=$(python3 -c "import json;print(json.load(open('data/puzzles.json'))['count'])")
after_latest=$(python3 -c "import json;print(json.load(open('data/puzzles.json'))['latest'])")
added=$((after_count - before_count))

if [ "$added" -gt 0 ]; then
  echo "🔢 $added new puzzle(s) added — now $after_count, newest $after_latest"
  echo "https://m7mdisk.github.io/ctc-sudokus/"
else
  echo "index refreshed: $after_count puzzles, metadata updated"
fi

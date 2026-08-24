#!/bin/bash
set -euo pipefail
cd gui
if ! bun x tsc --noEmit > /dev/null 2>&1; then echo "METRIC main_kb=9999"; exit 0; fi
START=$(date +%s)
bun run build > /tmp/gui-build.log 2>&1 || { echo "METRIC main_kb=9999"; cat /tmp/gui-build.log | tail -20; exit 0; }
END=$(date +%s)
BUILD_MS=$(( (END-START)*1000 ))
# parse vite's reported main size (most accurate)
MAIN=$(grep -oP 'dist/assets/index-.*?\.js\s+\K[0-9]+\.[0-9]+' /tmp/gui-build.log | head -1 | awk '{print int($1)}')
GZIP=$(grep -oP 'dist/assets/index-.*?\.js.*?gzip:\s+\K[0-9]+\.[0-9]+' /tmp/gui-build.log | head -1 | awk '{print int($1)}')
TOTAL=$(grep -oP 'dist/assets/.*?\.js\s+\K[0-9]+\.[0-9]+' /tmp/gui-build.log | awk '{sum+=$1} END {print int(sum)}')
CHUNKS=$(grep -c 'dist/assets/.*\.js' /tmp/gui-build.log || echo 9)
echo "METRIC main_kb=$MAIN"
echo "METRIC gzip_kb=$GZIP"
echo "METRIC total_js_kb=$TOTAL"
echo "METRIC build_ms=$BUILD_MS"
echo "METRIC chunks=$CHUNKS"
cat /tmp/gui-build.log | grep -E "dist/assets/(index|providers|modellen|claude|grok|dashboard|usage|verkeer)" | head -10

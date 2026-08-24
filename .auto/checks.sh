#!/bin/bash
set -euo pipefail
# correctness: typecheck + lint + focused tests
bun x tsc --noEmit 2>&1 | tail -5
cd gui && bun run lint 2>&1 | tail -5
cd .. && bun test tests/server-auth.test.ts tests/usage-log.test.ts 2>&1 | tail -10

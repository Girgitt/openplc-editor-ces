#!/usr/bin/env bash
# Deliberately opt-in: NEVER call this from test:ces-web-server, verify-all,
# editor publishing, or regular Playwright/Jest suites.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# No downloads or long compiler builds during prerequisite validation.
if [[ "${1:-}" == '--help' ]]; then
  cat <<'USAGE'
Usage: scripts/test-ces-simulation-e2e.sh [--case M53_FBD_RS|M53_LD_AND|M53_LD_OR|M53_ST_TON]
       scripts/test-ces-simulation-e2e.sh --check

Real browser + compiler simulation tests (slow, opt-in).
Missing dependencies? Run: ./scripts/bootstrap-ces-simulation-e2e.sh
USAGE
  exit 0
fi
node scripts/check-ces-simulation-e2e-prereqs.mjs
if [[ "${1:-}" == '--check' ]]; then
  exit 0
fi
# Arduino + STruC++ take ~30 seconds or more per scenario. Never retry a
# compilation just because a browser assertion failed: retain trace artifacts.
node tests/ces-simulation-e2e/run.mjs "$@"

#!/usr/bin/env bash
# Deliberately opt-in: NEVER call this from test:ces-web-server, verify-all,
# editor publishing, or regular Playwright/Jest suites.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if [[ ! -d node_modules ]]; then
  echo 'ERROR: editor dependencies missing. Run npm ci in the editor submodule.' >&2
  exit 2
fi
if [[ ! -f release/app/dist/ces-web/index.html || ! -f openplc-cli.dev.js ]]; then
  echo 'ERROR: editor not built. Run npm run build:ces-web first.' >&2
  exit 2
fi
# Arduino + STruC++ take ~30 seconds or more per scenario. Never retry a
# compilation just because a browser assertion failed: retain trace artifacts.
node tests/ces-simulation-e2e/run.mjs "$@"

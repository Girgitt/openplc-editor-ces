#!/usr/bin/env bash
# Explicit, opt-in development bootstrap for the real browser + simulator suite.
# Not invoked by normal CES/editor verification or the editor publish script.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WITH_SYSTEM_DEPS=0
REBUILD=0
usage() {
  cat <<'USAGE'
Usage: scripts/bootstrap-ces-simulation-e2e.sh [--with-system-deps] [--rebuild]

Prepare the local editor simulator E2E environment:
  - install pinned npm dependencies (npm ci) if missing
  - install pinned STruC++ if absent; restore Electron runtime if necessary
  - install Chromium matching the local Playwright package
  - build CES web renderer + development CLI if absent (or --rebuild)
  - verify browser startup and build prerequisites

  --with-system-deps  Allow Playwright to install missing Linux system packages
                      (may invoke sudo/apt). Not used by default.
  --rebuild           Rebuild the editor bundle even when already present.
  -h, --help          Show help.

Bootstrap deliberately installs dependencies. E2E execution itself never does.
USAGE
}
while (($#)); do
  case "$1" in
    --with-system-deps) WITH_SYSTEM_DEPS=1 ;;
    --rebuild) REBUILD=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown bootstrap option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

command -v node >/dev/null || { echo 'ERROR: Node.js 22/23 required.' >&2; exit 2; }
command -v npm >/dev/null || { echo 'ERROR: npm >=10 required.' >&2; exit 2; }
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 22 || NODE_MAJOR >= 24 )); then
  echo "ERROR: Node.js >=22 <24 required (found $(node --version))." >&2
  exit 2
fi
if [[ ! -f package-lock.json ]]; then
  echo 'ERROR: package-lock.json missing; cannot install pinned dependencies.' >&2
  exit 2
fi

echo '== OpenPLC simulation E2E environment bootstrap =='
if [[ ! -f node_modules/@playwright/test/package.json ]]; then
  echo '== Installing editor dependencies from package-lock.json =='
  npm_config_engine_strict=false npm ci --ignore-scripts
fi
if [[ ! -f node_modules/strucpp/libs/iec-types.json ]]; then
  echo '== Installing pinned STruC++ toolchain =='
  npm_config_engine_strict=false npm run setup:strucpp
fi

# npm ci --ignore-scripts does not initialize Electron; use the existing
# version-aware installer/repair logic instead of a second custom downloader.
node scripts/ensure-electron-runtime.mjs

if (( WITH_SYSTEM_DEPS )); then
  echo '== Installing Chromium and Linux system dependencies =='
  ./node_modules/.bin/playwright install --with-deps chromium
else
  echo '== Installing matching Playwright Chromium (user cache only) =='
  ./node_modules/.bin/playwright install chromium
fi

if (( REBUILD )) || [[ ! -f release/app/dist/ces-web/index.html || ! -f openplc-cli.dev.js ]]; then
  echo '== Building CES web renderer and OpenPLC development CLI =='
  npm run build:ces-web
fi

node scripts/check-ces-simulation-e2e-prereqs.mjs
echo 'Ready. Run the opt-in suite with ./scripts/test-ces-simulation-e2e.sh'

#!/usr/bin/env node
/**
 * Fail-fast, read-only prerequisite check for the opt-in simulator suite.
 * Launching Chromium verifies the exact Playwright revision AND shared libraries.
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const missing = []
const check = (relative, reason) => {
  if (!existsSync(join(root, relative))) missing.push(`${reason}: ${relative}`)
}

check('node_modules/@playwright/test/package.json', 'Playwright npm dependency missing')
check('node_modules/strucpp/libs/iec-types.json', 'STruC++ dependency missing')
check('node_modules/electron/path.txt', 'Electron runtime not initialized')
check('release/app/dist/ces-web/index.html', 'CES web renderer not built')
check('openplc-cli.dev.js', 'OpenPLC development CLI not built')

if (missing.length === 0) {
  try {
    const { chromium } = await import('@playwright/test')
    // Headless launch probes the actual headless_shell binary and OS shared libs.
    const browser = await chromium.launch({ headless: true, timeout: 15000 })
    await browser.close()
  } catch (error) {
    const detail = String(error?.message ?? error).split('\n').slice(0, 8).join('\n')
    missing.push(`Playwright Chromium cannot launch:\n${detail}`)
  }
}

if (missing.length) {
  console.error('ERROR: OpenPLC simulation E2E prerequisites are not ready:')
  for (const item of missing) console.error(`  - ${item}`)
  console.error('\nRun the explicit environment bootstrap:')
  console.error('  From CES root:    ./scripts/bootstrap-openplc-simulation-e2e.sh')
  console.error('  From editor root: ./scripts/bootstrap-ces-simulation-e2e.sh')
  console.error('If Chromium reports missing Linux libraries, retry bootstrap with --with-system-deps.')
  process.exitCode = 2
} else {
  console.log('OpenPLC simulation E2E prerequisites: PASS (including Chromium launch)')
}

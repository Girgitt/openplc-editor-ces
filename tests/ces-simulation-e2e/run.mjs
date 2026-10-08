#!/usr/bin/env node
/**
 * Opt-in REAL CES web editor → OpenPLC CLI → AVR8js debugger acceptance checks.
 * These are intentionally not Jest's mocked compiler contract tests.
 * Each case uses a temporary isolated project and a fresh browser context.
 */
import assert from 'node:assert/strict'
import { promises as fs, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { createCesEditorServer } from '../../scripts/ces-web-server.mjs'
import { PROJECT_CASES, createFixture } from './fixtures.mjs'
import { clickBooleanDebugAction, openNativeDebugger } from './debug-controls.mjs'
import { runLdBooleanTruthTable, runRsSetReset } from './scenarios.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const artifacts = resolve(process.env.CES_SIM_E2E_ARTIFACTS ?? join(root, 'test-results', 'ces-simulation-e2e'))
const timeoutMs = Number(process.env.CES_SIM_E2E_TIMEOUT_MS ?? 240000)
const token = 'ces-m53-e2e-test-token'
const report = []
const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms))

function expectPrerequisites() {
  const required = [
    join(root, 'release', 'app', 'dist', 'ces-web', 'index.html'),
    join(root, 'openplc-cli.dev.js'),
    join(root, 'node_modules', 'electron', 'path.txt'),
  ]
  for (const path of required) {
    if (!existsSync(path)) throw new Error(`Missing ${path}. Run npm run build:ces-web first; E2E never silently skips.`)
  }
  if (!(Number.isFinite(timeoutMs) && timeoutMs >= 30000)) throw new Error('CES_SIM_E2E_TIMEOUT_MS must be >= 30000')
}

async function until(check, description, limit = timeoutMs) {
  const started = Date.now()
  let lastError = ''
  while (Date.now() - started < limit) {
    try {
      const result = await check()
      if (result) return result
    } catch (err) { lastError = String(err) }
    await pause(400)
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `; last error: ${lastError}` : ''}`)
}

function lookup(snapshot, variable) {
  const name = variable.toLowerCase()
  return (snapshot.values ?? []).find((v) => {
    const key = String(v.key ?? '').toLowerCase()
    return key.endsWith(`:${name}`) || key.endsWith(`.${name}`) || key === name
  })
}
function boolValue(entry) {
  const v = String(entry?.value ?? '').toUpperCase()
  return v === 'TRUE' || v === '1'
}

async function runCase(browser, fixture) {
  const temp = await fs.mkdtemp(join(tmpdir(), 'openplc-ces-m53-e2e-'))
  const project = join(temp, fixture.name)
  await createFixture(project, fixture)
  const server = await createCesEditorServer({
    host: '127.0.0.1', port: 0, projectRoot: temp, token,
    simulatorBuildTimeoutMs: timeoutMs,
  })
  let context
  let page
  let base
  let phase = 'setup'
  const call = async (path, init = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'x-ces-editor-token': token, 'content-type': 'application/json', ...(init.headers ?? {}) },
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${JSON.stringify(data).slice(0, 1400)}`)
    return data
  }
  try {
    const address = await server.listen()
    base = `http://127.0.0.1:${address.port}`
    context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, recordVideo: { dir: artifacts } })
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
    page = await context.newPage()
    const browserErrors = []
    page.on('pageerror', (error) => browserErrors.push(error.message))

    phase = 'first-open'
    await page.goto(`${base}/?project_id=${fixture.name}#token=${token}`, { waitUntil: 'domcontentloaded' })
    await until(async () => (await call('/api/health')).documentLoaded, 'editor project load', 45000)
    // This is a real browser, not a direct compiler fixture. Select the program
    // in the navigator and ensure its editor is mounted before any save/build.
    await page.getByText(fixture.name, { exact: true }).first().click({ timeout: 45000 })
    if (fixture.ext !== 'st') {
      await page.locator('.react-flow').first().waitFor({ state: 'visible', timeout: 30000 })
    }

    phase = 'save-and-reopen'
    const original = await call('/api/document')
    await page.keyboard.press('ControlOrMeta+s')
    await until(async () => (await call('/api/health')).documentRevision > original.revision,
      'Ctrl+S to persist editor changes', 45000)
    const saved = await call('/api/document')
    const savedPou = saved.document.files.pouFiles.find((p) => p.relativePath.endsWith(`/${fixture.name}.${fixture.ext}`))
    assert.ok(savedPou, `Saved POU ${fixture.name}.${fixture.ext} missing`)
    if (fixture.ext !== 'st') {
      const bodyStart = savedPou.content.indexOf('\n{')
      assert.ok(bodyStart >= 0, 'Saved graphical POU does not contain JSON body')
      const body = JSON.parse(savedPou.content.slice(bodyStart + 1, savedPou.content.lastIndexOf('END_PROGRAM')).trim())
      const rungs = fixture.ext === 'fbd' ? [body.rung] : body.rungs
      assert.ok(Array.isArray(rungs) && rungs.length, 'No saved graphical rungs')
      assert.ok(rungs.every((r) => Array.isArray(r.nodes) && r.nodes.length && Array.isArray(r.edges) && r.edges.length),
        'Saved graphical network lacks nodes or semantic edges')
      if (fixture.ext === 'fbd') {
        const rs = rungs[0].nodes.find((n) => n.data?.variant?.name === 'RS')
        assert.ok(rs, 'Saved RS block was lost')
        assert.deepEqual(new Set(rungs[0].edges.filter((e) => e.target === rs.id).map((e) => e.targetHandle)),
          new Set(['S', 'R1']), 'RS semantic port IDs changed')
      }
    }
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByText(fixture.name, { exact: true }).first().click({ timeout: 45000 })
    if (fixture.ext !== 'st') await page.locator('.react-flow').first().waitFor({ state: 'visible', timeout: 30000 })

    phase = 'real-compiler-and-simulator'
    // Start is the real editor button: it flushes authoritative POU data,
    // calls /api/simulator/build (real STruC++ + Arduino), loads AVR8js and
    // attaches its own debugger. We must not call a fake builder or inject values.
    await page.getByRole('button', { name: 'Play', exact: true }).click({ timeout: 15000 })
    await until(async () => (await call('/api/health')).simulatorBuildRevision > 0,
      'real OpenPLC CLI simulator build', timeoutMs)
    const live = await until(async () => {
      const snapshot = await call('/api/simulator/live')
      return snapshot.active && snapshot.values?.length > 0 ? snapshot : false
    }, 'nonempty live debug snapshot from AVR8js', 45000)
    assert.ok(live.values.length > 0, 'Running simulator has no debug leaves')
    // The real debugger's watch panel exposes force/release for local variables
    // consistently across FBD and LD. Clicking the canvas itself does not:
    // FBD variable boxes use a validation-dependent popover and LD contacts
    // open theirs on left-click rather than right-click.
    if (fixture.input) await openNativeDebugger(page)

    if (fixture.input) {
      phase = 'force-and-observe'
      assert.equal(boolValue(lookup(live, fixture.output)), false,
        `${fixture.name}: expected FALSE output before forcing inputs`)
      const forceBool = async (name, value) => {
        await clickBooleanDebugAction(page, fixture.name, name, value ? 'Force True' : 'Force False')
        // A menu disappearing is not proof that the transport applied the force.
        await until(async () => {
          const input = lookup(await call('/api/simulator/live'), name)
          return input && boolValue(input) === value ? input : false
        }, `${fixture.name}: ${name} executes force ${value}`, 15000)
      }
      const releaseBool = async (name) => {
        // The native debugger waits for forced=false after a successful
        // release. Do not assert that the runtime value resets to its initial
        // value: these test locals have no PLC writer, so the value can persist.
        await clickBooleanDebugAction(page, fixture.name, name, 'Release Force')
      }
      const expectOutput = async (expected, description) => until(async () => {
        const output = lookup(await call('/api/simulator/live'), fixture.output)
        return output && boolValue(output) === expected ? output : false
      }, description, 30000)

      if (fixture.ext === 'ld') {
        await runLdBooleanTruthTable({
          isAnd: fixture.name === 'M53_LD_AND', forceBool, releaseBool, expectOutput,
        })
      } else {
        await runRsSetReset({ forceBool, releaseBool, expectOutput })
      }
    } else {
      await until(async () => {
        const snapshot = await call('/api/simulator/live')
        return boolValue(lookup(snapshot, fixture.output)) ? snapshot : false
      }, `${fixture.name}: TON reaches preset`, 30000)
    }

    phase = 'stop'
    await page.getByRole('button', { name: 'Play', exact: true }).click({ timeout: 15000 })
    await until(async () => !(await call('/api/simulator/live')).active, 'simulator stopped', 15000)
    if (fixture.name === 'M53_FBD_RS') {
      // Explicitly exercise another compile/start cycle after stop. No stale
      // simulator/debugger state may survive across separate runs.
      phase = 'restart-after-stop'
      const beforeRestart = (await call('/api/health')).simulatorBuildRevision
      await page.getByRole('button', { name: 'Play', exact: true }).click({ timeout: 15000 })
      await until(async () => (await call('/api/health')).simulatorBuildRevision > beforeRestart,
        'second real simulator build', timeoutMs)
      await until(async () => (await call('/api/simulator/live')).active, 'second debug session active', 45000)
      await page.getByRole('button', { name: 'Play', exact: true }).click({ timeout: 15000 })
      await until(async () => !(await call('/api/simulator/live')).active, 'second simulator stopped', 15000)
    }
    assert.deepEqual(browserErrors, [], `Uncaught browser errors: ${browserErrors.join('; ')}`)
    return { name: fixture.name, status: 'PASS', buildRevision: (await call('/api/health')).simulatorBuildRevision }
  } catch (error) {
    if (page) await page.screenshot({ path: join(artifacts, `${fixture.name}.png`), fullPage: true }).catch(() => {})
    const diagnostics = {
      fixture: fixture.name, phase, message: String(error), stack: error?.stack,
      health: base ? await call('/api/health').catch((e) => String(e)) : null,
      live: base ? await call('/api/simulator/live').catch((e) => String(e)) : null,
      debugRows: page ? await page.locator('[data-debug-variable]').evaluateAll((rows) => rows.map((row) => ({
        key: row.getAttribute('data-debug-variable'),
        forceable: row.getAttribute('data-debug-forceable'),
        forced: row.getAttribute('data-debug-forced'),
        forcedValue: row.getAttribute('data-debug-forced-value'),
        text: row.textContent?.trim().slice(0, 120),
      }))).catch(() => []) : [],
    }
    await fs.writeFile(join(artifacts, `${fixture.name}.failure.json`), JSON.stringify(diagnostics, null, 2))
    throw error
  } finally {
    if (context) {
      await context.tracing.stop({ path: join(artifacts, `${fixture.name}.trace.zip`) }).catch(() => {})
      await context.close().catch(() => {})
    }
    await server.close().catch(() => {})
    await fs.rm(temp, { recursive: true, force: true })
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('Usage: scripts/test-ces-simulation-e2e.sh [--case M53_FBD_RS|M53_LD_AND|M53_LD_OR|M53_ST_TON]')
    console.log('Opt-in real-browser + real-compiler + simulator/force acceptance tests.')
    return
  }
  const caseIndex = args.indexOf('--case')
  if (args.some((a, i) => a.startsWith('--') && a !== '--case' && i !== caseIndex + 1)) {
    throw new Error(`Unknown argument(s): ${args.join(' ')}`)
  }
  if (caseIndex >= 0 && !args[caseIndex + 1]) throw new Error('--case needs a case name')
  const selected = caseIndex >= 0
    ? PROJECT_CASES.filter((f) => f.name === args[caseIndex + 1])
    : PROJECT_CASES
  if (!selected.length) throw new Error(`Unknown case: ${args[caseIndex + 1]}`)
  await fs.mkdir(artifacts, { recursive: true })
  expectPrerequisites()
  const browser = await chromium.launch({ headless: process.env.CES_SIM_E2E_HEADED !== '1' })
  let failed = false
  try {
    for (const fixture of selected) {
      console.log(`\n== CES simulator E2E: ${fixture.name} (serial; real compiler) ==`)
      try {
        const result = await runCase(browser, fixture)
        console.log(`${fixture.name}: PASS`)
        report.push(result)
      } catch (error) {
        failed = true
        console.error(`${fixture.name}: FAIL: ${error.stack ?? error}`)
        report.push({ name: fixture.name, status: 'FAIL', error: String(error) })
      }
    }
  } finally { await browser.close() }
  await fs.writeFile(join(artifacts, 'summary.json'), JSON.stringify(report, null, 2))
  console.log(`\nArtifacts: ${artifacts}`)
  if (failed) process.exitCode = 1
}
main().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1 })

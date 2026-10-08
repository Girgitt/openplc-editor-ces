import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clickBooleanDebugAction, debugVariableKey, openNativeDebugger } from './debug-controls.mjs'

function fakePage() {
  const calls = []
  const locator = (path) => ({
    locator(next) { return locator(`${path} ${next}`) },
    getByText(text, opts) {
      assert.deepEqual(opts, { exact: true })
      return locator(`${path} text=${text}`)
    },
    async click(opts) { calls.push(['click', path, opts]) },
    async waitFor(opts) { calls.push(['wait', path, opts]) },
  })
  const page = {
    calls,
    getByRole(role, opts) { return locator(`${role}:${opts.name}`) },
    getByTestId(id) { return locator(`testid:${id}`) },
  }
  return page
}

test('native debugger tab is selected before force controls', async () => {
  const page = fakePage()
  await openNativeDebugger(page)
  assert.equal(page.calls[0][1], 'tab:Debugger')
  assert.equal(page.calls[1][1], 'testid:openplc-debug-variables')
})

test('force TRUE targets exactly one scoped variable and waits for forced state', async () => {
  const page = fakePage()
  await clickBooleanDebugAction(page, 'M53_LD_AND', 'v1', 'Force True')
  assert.equal(debugVariableKey('M53_LD_AND', 'v1'), 'M53_LD_AND:v1')
  assert.ok(page.calls.some(([kind, path]) => kind === 'click' && path.includes('testid:openplc-debug-force-menu text=Force True')))
  assert.ok(page.calls.some(([kind, path]) => kind === 'wait' && path.includes('[data-debug-forced="true"][data-debug-forced-value="true"]')))
  assert.ok(page.calls.every(([, path]) => !path.includes('.react-flow__node')))
})

test('release waits for debugger to clear the forced state', async () => {
  const page = fakePage()
  await clickBooleanDebugAction(page, 'M53_FBD_RS', 'v2', 'Release Force')
  assert.ok(page.calls.some(([kind, path]) => kind === 'wait' && path.includes('[data-debug-forced="false"]')))
})

test('unknown commands and CSS-unsafe names fail rather than operating on a wrong variable', async () => {
  await assert.rejects(clickBooleanDebugAction(fakePage(), 'M53_FBD_RS', 'v1', 'Force Value'), /Unsupported/)
  await assert.rejects(clickBooleanDebugAction(fakePage(), 'M53_FBD_RS', 'v1"]', 'Force True'), /identifier/)
})

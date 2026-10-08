/**
 * Exercise the real native debugger force menu, not graphical-node context menus.
 * The latter differ between FBD and LD and may require LSP readiness.
 * These functions only click DOM controls: they do not mutate PLC state directly.
 */
export const debugVariableKey = (programName, variableName) => `${programName}:${variableName}`

export function debugVariableRow(page, programName, variableName) {
  const key = debugVariableKey(programName, variableName)
  // Fixture identifiers are IEC-compatible, but guard against accidental CSS selector injection.
  if (!/^[A-Za-z_][A-Za-z0-9_]*:[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Unexpected debug variable identifier: ${key}`)
  }
  return page.getByTestId('openplc-debug-variables').locator(`[data-debug-variable="${key}"]`)
}

export async function openNativeDebugger(page) {
  await page.getByRole('tab', { name: 'Debugger', exact: true }).click({ timeout: 20000 })
  await page.getByTestId('openplc-debug-variables').waitFor({ state: 'visible', timeout: 20000 })
}

export async function clickBooleanDebugAction(page, programName, variableName, action) {
  if (!['Force True', 'Force False', 'Release Force'].includes(action)) {
    throw new Error(`Unsupported debugger action: ${action}`)
  }
  const key = debugVariableKey(programName, variableName)
  const row = debugVariableRow(page, programName, variableName)
  await row.waitFor({ state: 'visible', timeout: 20000 })
  // A visible watch row is not enough: the debugger must have a resolved address.
  await page.getByTestId('openplc-debug-variables')
    .locator(`[data-debug-variable="${key}"][data-debug-forceable="true"]`)
    .waitFor({ state: 'visible', timeout: 20000 })
  await row.click({ timeout: 10000 })
  const menu = page.getByTestId('openplc-debug-force-menu')
  await menu.getByText(action, { exact: true }).click({ timeout: 10000 })
  const expectedAttrs = action === 'Release Force'
    ? `[data-debug-forced="false"]`
    : `[data-debug-forced="true"][data-debug-forced-value="${action === 'Force True'}"]`
  await page.getByTestId('openplc-debug-variables')
    .locator(`[data-debug-variable="${key}"]${expectedAttrs}`)
    .waitFor({ state: 'visible', timeout: 15000 })
}

/**
 * Semantic execution scenarios for live E2E tests. Keeping these separate from
 * the Playwright transport lets the force/release order be verified quickly.
 *
 * IEC debugger RELEASE removes the override, it does NOT reset a variable to
 * its declaration's initial value. With no PLC write to a local variable,
 * its last runtime value may persist after release.
 */

export async function runLdBooleanTruthTable({ isAnd, forceBool, releaseBool, expectOutput }) {
  const label = isAnd ? 'LD AND' : 'LD OR'
  for (const [v1, v2] of [[false, false], [true, false], [false, true], [true, true]]) {
    await forceBool('v1', v1)
    await forceBool('v2', v2)
    await expectOutput(isAnd ? v1 && v2 : v1 || v2, `${label}: v1=${v1} v2=${v2} truth-table output`)
  }

  // Reapply FALSE explicitly *before* releasing. Release does not restore the
  // original initial value, because neither v1 nor v2 has a PLC-side writer.
  await forceBool('v1', false)
  await forceBool('v2', false)
  await expectOutput(false, `${label}: both inputs explicitly FALSE`)
  await releaseBool('v1')
  await releaseBool('v2')
}

export async function runRsSetReset({ forceBool, releaseBool, expectOutput }) {
  await forceBool('v1', true)
  await expectOutput(true, 'RS set drives out1 TRUE')

  // Verify the RS retains Q1 with S deasserted, not with an unforced S that
  // might still hold its last runtime TRUE value after release.
  await forceBool('v1', false)
  await expectOutput(true, 'RS latch retains Q1 with S forced FALSE')
  await releaseBool('v1')

  await forceBool('v2', true)
  await expectOutput(false, 'RS reset drives out1 FALSE')
  await forceBool('v2', false)
  await expectOutput(false, 'RS remains reset with R1 forced FALSE')
  await releaseBool('v2')
}

/** Mixed single-rung ladder: both parallel paths AND the downstream contact. */
export async function runLdMixedTruthTable({ forceBool, releaseBool, expectOutput }) {
  for (const v1 of [false, true]) {
    for (const v2 of [false, true]) {
      for (const v3 of [false, true]) {
        await forceBool('v1', v1)
        await forceBool('v2', v2)
        await forceBool('v3', v3)
        await expectOutput((v1 || v2) && v3,
          `LD mixed: (${v1} OR ${v2}) AND ${v3} truth-table output`)
      }
    }
  }
  for (const name of ['v1', 'v2', 'v3']) await forceBool(name, false)
  await expectOutput(false, 'LD mixed: explicitly clear all three inputs')
  for (const name of ['v1', 'v2', 'v3']) await releaseBool(name)
}

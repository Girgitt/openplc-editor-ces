import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runLdBooleanTruthTable, runLdMixedTruthTable, runRsSetReset } from './scenarios.mjs'

function unforcedLocalRuntime() {
  const values = { v1: false, v2: false }
  const forced = new Set()
  const actions = []
  return {
    values,
    forced,
    actions,
    forceBool: async (name, value) => {
      values[name] = value
      forced.add(name)
      actions.push(`force:${name}:${value}`)
    },
    releaseBool: async (name) => {
      assert.ok(forced.has(name), `${name} must have been forced`)
      forced.delete(name)
      // Deliberately DO NOT change values[name]. That is the failure mode
      // which the old browser test mistakenly treated as a PLC fault.
      actions.push(`release:${name}`)
    },
  }
}

test('RS set/latch/reset does not rely on release restoring declared initial values', async () => {
  const runtime = unforcedLocalRuntime()
  let q = false
  await runRsSetReset({
    ...runtime,
    expectOutput: async (expected) => {
      if (runtime.values.v2) q = false
      else if (runtime.values.v1) q = true
      assert.equal(q, expected)
    },
  })
  assert.deepEqual(runtime.actions, [
    'force:v1:true', 'force:v1:false', 'release:v1',
    'force:v2:true', 'force:v2:false', 'release:v2',
  ])
  assert.equal(runtime.forced.size, 0)
  assert.equal(q, false)
})

for (const isAnd of [true, false]) {
  test(`LD ${isAnd ? 'AND' : 'OR'} covers full truth table then explicitly clears inputs`, async () => {
    const runtime = unforcedLocalRuntime()
    const observed = []
    await runLdBooleanTruthTable({
      ...runtime,
      isAnd,
      expectOutput: async (expected) => {
        const actual = isAnd
          ? runtime.values.v1 && runtime.values.v2
          : runtime.values.v1 || runtime.values.v2
        assert.equal(actual, expected)
        observed.push(actual)
      },
    })
    assert.deepEqual(observed, isAnd
      ? [false, false, false, true, false]
      : [false, true, true, true, false])
    assert.equal(runtime.forced.size, 0)
    assert.equal(runtime.values.v1, false)
    assert.equal(runtime.values.v2, false)
    assert.deepEqual(runtime.actions.slice(-4), [
      'force:v1:false', 'force:v2:false', 'release:v1', 'release:v2',
    ])
  })
}


test('LD mixed (v1 OR v2) AND v3 exercises all eight rows and releases each input', async () => {
  const runtime = unforcedLocalRuntime()
  runtime.values.v3 = false
  const observed = []
  await runLdMixedTruthTable({
    ...runtime,
    expectOutput: async (expected) => {
      const actual = (runtime.values.v1 || runtime.values.v2) && runtime.values.v3
      assert.equal(actual, expected)
      observed.push(actual)
    },
  })
  assert.deepEqual(observed, [false, false, false, true, false, true, false, true, false])
  assert.equal(runtime.forced.size, 0)
  assert.deepEqual(runtime.values, { v1: false, v2: false, v3: false })
  assert.deepEqual(runtime.actions.slice(-3), ['release:v1', 'release:v2', 'release:v3'])
})

import type { Edge, Node } from '@xyflow/react'

import { normalizeFbdEdges } from '../fbd-edge-integrity'

const pin = (id: string) => ({ id, relPosition: { x: 0, y: 20 }, glbPosition: { x: 0, y: 20 } })
const node = (id: string, inputPins: string[], outputPins: string[]): Node => ({
  id,
  type: inputPins.length ? 'block' : 'input-variable',
  position: { x: 0, y: 0 },
  data: {
    inputHandles: inputPins.map(pin),
    outputHandles: outputPins.map(pin),
  },
})
const wire = (sourceHandle: string | null, targetHandle: string | null): Edge => ({
  id: 'set-wire',
  source: 'v1',
  target: 'rs',
  sourceHandle,
  targetHandle,
})
const nodes = [node('v1', [], ['output-variable']), node('rs', ['S', 'R1'], ['Q1'])]

describe('FBD semantic edge integrity', () => {
  it('preserves a valid RS.S connection unchanged', () => {
    const edge = wire('output-variable', 'S')
    expect(normalizeFbdEdges(nodes, [edge])).toEqual([edge])
  })

  it('repairs an old leaf output alias and IEC pin casing without moving the connection', () => {
    expect(normalizeFbdEdges(nodes, [wire('out', 's')])[0]).toEqual(
      expect.objectContaining({ source: 'v1', sourceHandle: 'output-variable', target: 'rs', targetHandle: 'S' }),
    )
  })

  it('does not guess between S and R1 when an RS target pin cannot be resolved', () => {
    expect(() => normalizeFbdEdges(nodes, [wire('output-variable', 'EN')])).toThrow(/available target pins: S, R1/)
  })

  it('rejects a dangling source instead of silently exporting a disconnected RS', () => {
    expect(() => normalizeFbdEdges(nodes, [{ ...wire('output-variable', 'S'), source: 'missing' }])).toThrow(
      /references missing node/,
    )
  })

  it('refuses an unrecognized output pin even on a single-output variable', () => {
    expect(() => normalizeFbdEdges(nodes, [wire('random', 'S')])).toThrow(/available source pins/)
  })

  it('rejects duplicate PLCopen local IDs even if ReactFlow node IDs differ', () => {
    const sameId = nodes.map((item) => ({ ...item, data: { ...item.data, numericId: '42' } }))
    expect(() => normalizeFbdEdges(sameId, [wire('output-variable', 'S')])).toThrow(/share PLCopen localId/)
  })

  it('rejects an omitted target pin on a multi-input RS', () => {
    expect(() => normalizeFbdEdges(nodes, [wire('output-variable', null)])).toThrow(/available target pins: S, R1/)
  })
})

import type { RungLadderState } from '@root/middleware/shared/ports/types'
import { create } from 'xmlbuilder2'

import { ladderToXml } from '../../../xml-generator/old-editor/language/ladder-xml'
import { ldExecutableSignature } from '../../../ld-graph-metadata'
import { parseLadderXml } from '../ladder-xml'
import { parseXmlDocument } from '../../parse-xml-document'
import { parsePousXml } from '../../pou-xml'

// The exact structure authored in the editor: ONE rung containing a parallel
// v1/v2 network followed by serial v3 and an output coil.
const handle = (id: string, x: number, y: number) => ({
  id, type: 'source', position: 'right',
  relPosition: { x: 0, y: 16 }, glbPosition: { x, y },
})
const node = (id: string, numericId: string, type: string, x: number, y: number, name = '') => {
  const input = handle(type === 'powerRail' && id === 'right' ? 'right-rail' : 'input', x, y + 16)
  const output = handle(type === 'powerRail' && id === 'left' ? 'left-rail' : 'output', x + 48, y + 16)
  return {
    id, type, position: { x, y }, width: 48, height: 32,
    data: {
      numericId, variable: { name }, executionOrder: 0,
      variant: type === 'powerRail' ? id : 'default',
      handles: [input, output], inputHandles: [input], outputHandles: [output],
      inputConnector: input, outputConnector: output,
      draggable: true, selectable: true, deletable: true,
    },
  }
}
const parallel = (id: string, numericId: string, type: 'open' | 'close', x: number, y: number) => {
  const junction = node(id, numericId, 'parallel', x, y)
  const inputDown = handle('input-down', x + 24, y + 40)
  const outputDown = handle('output-down', x + 24, y + 40)
  const inputTop = handle('input-top', x + 24, y)
  const outputTop = handle('output-top', x + 24, y)
  return {
    ...junction,
    data: {
      ...junction.data,
      type,
      variant: undefined,
      parallelInputConnector: type === 'close' ? inputDown : inputTop,
      parallelOutputConnector: type === 'open' ? outputDown : outputTop,
      parallelOpenReference: type === 'close' ? 'split' : undefined,
      parallelCloseReference: type === 'open' ? 'join' : undefined,
    },
  }
}
const e = (source: string, target: string, sourceHandle = 'output', targetHandle = 'input') => ({
  id: `${source}-${target}`, source, sourceHandle, target, targetHandle, type: 'smoothstep',
})
const mixedRung = (): RungLadderState => ({
  id: 'rung-original', comment: 'parallel-then-series', defaultBounds: [0, 0, 500, 125],
  reactFlowViewport: [500, 125], selectedNodes: [],
  nodes: [
    node('left', '1', 'powerRail', 0, 0),
    parallel('split', '2', 'open', 70, 0),
    node('v1', '3', 'contact', 135, 0, 'v1'),
    node('v2', '4', 'contact', 135, 80, 'v2'),
    parallel('join', '5', 'close', 213, 0),
    node('v3', '6', 'contact', 280, 0, 'v3'),
    node('coil', '7', 'coil', 360, 0, 'out'),
    node('right', '8', 'powerRail', 460, 0),
  ] as RungLadderState['nodes'],
  edges: [
    e('left', 'split', 'left-rail'),
    e('split', 'v1', 'output-right'),
    e('split', 'v2', 'output-down'),
    e('v1', 'join'),
    e('v2', 'join', 'output', 'input-down'),
    e('join', 'v3', 'output-right'),
    e('v3', 'coil'),
    e('coil', 'right', 'output', 'right-rail'),
  ],
})

const renderAndReparse = (rungs: RungLadderState[]) => {
  const { body } = ladderToXml(rungs)
  // The actual canonical flow serializes PLCopen XML and reparses it; use the
  // same XML library + parser rather than passing the in-memory object back.
  const text = create({ project: {
    '@xmlns': 'http://www.plcopen.org/xml/tc6_0201',
    types: { pous: { pou: {
      '@name': 'Mixed', '@pouType': 'program', interface: {}, body,
    } } },
  } }).end()
  const parsed = parseXmlDocument(text)
  const pousNode = (parsed.types as { pous: { pou: unknown } }).pous.pou
  const { pous, warnings } = parsePousXml(pousNode)
  const result = pous[0].body.value as { rungs: RungLadderState[] }
  return { rungs: result.rungs, warnings, xml: body.LD, text }
}

describe('CES canonical LD restore: parallel followed by series', () => {
  it('preserves one rung and ALL branch junctions after two full XML round trips', () => {
    const original = mixedRung()
    const once = renderAndReparse([original])
    expect(once.warnings).toEqual([])
    expect(once.rungs).toHaveLength(1)
    expect(once.rungs[0].nodes.map((node) => node.id)).toEqual(original.nodes.map((node) => node.id))
    expect(once.rungs[0].edges).toEqual(original.edges)
    expect(once.rungs[0].nodes.filter((node) => node.type === 'parallel')).toHaveLength(2)
    expect(once.rungs[0].id).toBe('rung-original')
    expect(once.rungs[0].comment).toBe('parallel-then-series')

    const twice = renderAndReparse(once.rungs)
    expect(twice.warnings).toEqual([])
    expect(twice.rungs).toHaveLength(1)
    expect(twice.rungs[0].nodes).toEqual(once.rungs[0].nodes)
    expect(twice.rungs[0].edges).toEqual(once.rungs[0].edges)
  })

  it('exports two independent power inputs to the downstream serial v3 contact', () => {
    const ld = ladderToXml([mixedRung()]).body.LD
    const serial = ld.contact.find((contact) => contact.variable === 'v3')
    expect(serial?.connectionPointIn.connection.map((connection) => connection['@refLocalId']).sort()).toEqual(['3', '4'])
  })

  it('reconstructs an unambiguous mixed rung from legacy PLCopen LD without editor metadata', () => {
    const { body } = ladderToXml([mixedRung()])
    // Simulate a third-party producer retaining executable LD but dropping
    // vendor authoring addData. XML serialization also converts numeric attrs
    // to strings, just as the real canonical importer expects.
    const text = create({ project: {
      '@xmlns': 'http://www.plcopen.org/xml/tc6_0201', types: { pous: { pou: {
        '@name': 'Mixed', '@pouType': 'program', interface: {}, body: { LD: body.LD },
      } } },
    } }).end()
    const parsed = parseXmlDocument(text)
    const ld = ((parsed.types as { pous: { pou: { body: { LD: unknown } } } }).pous.pou.body.LD)
    const legacy = parseLadderXml('Mixed', ld)
    expect(legacy.warnings).toEqual([])
    expect(legacy.body.rungs).toHaveLength(1)
    expect(legacy.body.rungs[0].nodes.filter((node) => node.type === 'parallel')).toHaveLength(2)
    // The new ReactFlow nodes must be connected in precisely the same IEC
    // executable network; otherwise this is a cosmetic but corrupt import.
    expect(ldExecutableSignature(ladderToXml(legacy.body.rungs).body.LD)).toBe(ldExecutableSignature(ld))
  })

  it('warns on legacy XML that already lost the branch-to-series connection', () => {
    const { body } = ladderToXml([mixedRung()])
    const serial = body.LD.contact.find((contact) => contact.variable === 'v3')
    expect(serial).toBeDefined()
    if (!serial) return
    serial.connectionPointIn.connection = []
    const parsed = parseLadderXml('Mixed', body.LD)
    expect(parsed.body.rungs.length).toBeGreaterThan(1)
    expect(parsed.warnings.join(' ')).toMatch(/disconnected LD rail fragments/)
  })

  it('rejects stale graph metadata when executable PLCopen connectivity is modified', () => {
    const { body } = ladderToXml([mixedRung()])
    const serial = body.LD.contact.find((contact) => contact.variable === 'v3')
    expect(serial).toBeDefined()
    if (!serial) return
    serial.connectionPointIn.connection = serial.connectionPointIn.connection.slice(0, 1)
    const parsed = parseLadderXml('Mixed', body.LD, body.addData)
    expect(parsed.warnings.join(' ')).toMatch(/stale layout/)
    expect(parsed.body.rungs[0]?.nodes.some((node) => node.type === 'parallel')).toBe(false)
  })

  it('does not restore a tampered authoring graph that contradicts executable XML', () => {
    const { body } = ladderToXml([mixedRung()])
    const data = body.addData.data['openplc:ldGraph']
    const payload = JSON.parse(data.$) as { rungs: RungLadderState[] }
    payload.rungs[0].edges = payload.rungs[0].edges.filter((edge) => edge.target !== 'v3')
    data.$ = JSON.stringify(payload)
    const parsed = parseLadderXml('Mixed', body.LD, body.addData)
    expect(parsed.warnings.join(' ')).toMatch(/conflicts with PLCopen wiring/)
  })
})

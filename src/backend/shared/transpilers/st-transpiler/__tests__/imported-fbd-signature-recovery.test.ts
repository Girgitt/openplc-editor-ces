import { generateGraphicalPou } from '@root/backend/shared/transpilers/st-transpiler/emit/pou-graphical'
import { compileStlib } from '@root/backend/shared/library/compile-stlib'
import type { TranspilePou, TranspileProject } from '@root/backend/shared/transpilers/st-transpiler/types'
import { asBlockData } from '@root/backend/shared/transpilers/st-transpiler/walker/narrow'
import type { RFNode, RFEdge } from '@root/backend/shared/transpilers/st-transpiler/walker/types'

// Reproduces the CES PLCopen bridge save/reopen state: the graphical block
// retains its connected XML pin handles, but its library variant.variables
// is empty until the editor's asynchronous library restamp has completed.
const input = (id: string, expression: string, y: number): RFNode => ({
  id,
  type: 'input-variable',
  position: { x: 0, y },
  data: { numericId: id, variant: 'input-variable', variable: { name: expression } },
})

const limit = (outputHandles: string[] = ['OUT'], variables: unknown[] = []): RFNode => ({
  id: 'limit',
  type: 'block',
  position: { x: 220, y: 50 },
  data: {
    numericId: '1',
    executionOrder: 0,
    executionControl: false,
    variable: { name: 'LIMIT' },
    variant: { name: 'LIMIT', type: 'function', variables },
    inputHandles: ['MN', 'IN', 'MX'].map((id) => ({ id })),
    outputHandles: outputHandles.map((id) => ({ id })),
  },
})

const destination: RFNode = {
  id: 'out',
  type: 'output-variable',
  position: { x: 440, y: 50 },
  data: { numericId: '5', variant: 'output-variable', variable: { name: 'DemandPct' } },
}

const wires: RFEdge[] = [
  { id: 'e1', source: 'zero', target: 'limit', targetHandle: 'MN' },
  { id: 'e2', source: 'manual', target: 'limit', targetHandle: 'IN' },
  { id: 'e3', source: 'hundred', target: 'limit', targetHandle: 'MX' },
  { id: 'e4', source: 'limit', sourceHandle: 'OUT', target: 'out' },
]

function projectWithLimit(block: RFNode): { pou: TranspilePou; project: TranspileProject } {
  const pou = {
    name: 'PumpRegulator',
    pouType: 'program',
    interface: {
      variables: [
        { name: 'ManualOutputPct', class: 'input', type: { definition: 'base-type', value: 'REAL' } },
        { name: 'DemandPct', class: 'output', type: { definition: 'base-type', value: 'REAL' } },
      ],
    },
    body: {
      language: 'fbd',
      value: {
        rung: {
          nodes: [input('zero', '0.0', 0), input('manual', 'ManualOutputPct', 50), input('hundred', '100.0', 100), block, destination],
          edges: wires,
        },
      },
    },
  } as TranspilePou
  const project = { pous: [pou], dataTypes: [], configurations: [] } as unknown as TranspileProject
  return { pou, project }
}

describe('FBD function import without a restored typed block signature', () => {
  it('recovers the pin names represented in the imported PLCopen block', () => {
    expect(asBlockData(limit().data)).toMatchObject({
      typeName: 'LIMIT',
      inputs: ['MN', 'IN', 'MX'],
      outputs: ['OUT'],
    })
  })

  it('emits the declaration, function call, and unmapped VAR_OUTPUT assignment', () => {
    const { pou, project } = projectWithLimit(limit())
    const st = generateGraphicalPou(pou, project).map((chunk) => chunk[0]).join('')
    expect(st).toContain('_TMP_LIMIT1_OUT : REAL;')
    expect(st).toContain('_TMP_LIMIT1_OUT := LIMIT(0.0, ManualOutputPct, 100.0);')
    expect(st).toContain('DemandPct := _TMP_LIMIT1_OUT;')
  })

  it('does not override the typed block signature already present in the project', () => {
    const block = limit(['OUT'], [
      { name: 'MN', class: 'input' },
      { name: 'IN', class: 'input' },
      { name: 'MX', class: 'input' },
      { name: 'OUT', class: 'output' },
    ])
    expect(asBlockData(block.data)?.inputs).toEqual(['MN', 'IN', 'MX'])
    expect(asBlockData(block.data)?.outputs).toEqual(['OUT'])
  })

  it('raises a diagnostic instead of emitting an undeclared temporary when the output pin is missing', () => {
    const { pou, project } = projectWithLimit(limit([]))
    expect(() => generateGraphicalPou(pou, project)).toThrow(
      'Function LIMIT (limit) has no resolved primary output signature',
    )
  })
})

// Canonical CES FBD import can list blocks before their input nodes, with
// only persisted PLCopen formal pin names and no library types. The simple
// P-controller LevelSP - LevelPV -> MUL(Kp) -> DIV -> LIMIT exercised this.
const arithmetic = (name: string, numericId: string): RFNode => ({
  id: name.toLowerCase(),
  type: 'block',
  position: { x: 120 + 140 * Number(numericId), y: 180 },
  data: {
    numericId,
    executionOrder: 0,
    variable: { name },
    variant: { name, type: 'function', variables: [] },
    inputHandles: ['IN1', 'IN2'].map((id) => ({ id })),
    outputHandles: [{ id: 'OUT' }],
  },
})

function pControllerWithImportedBlocks(): { pou: TranspilePou; project: TranspileProject } {
  const sub = arithmetic('SUB', '3')
  const mul = arithmetic('MUL', '4')
  const div = arithmetic('DIV', '6')
  const limitBlock = limit()
  const readSP = input('sp', 'LevelSPPct', 180)
  const readPV = input('pv', 'LevelPVPct', 220)
  const readKP = input('kp', 'Kp', 260)
  const readDivisor = input('divisor', 'Divisor', 300)
  const { pou, project } = projectWithLimit(limitBlock)
  pou.interface.variables.push(
    { name: 'LevelSPPct', class: 'input', type: { definition: 'base-type', value: 'REAL' } },
    { name: 'LevelPVPct', class: 'input', type: { definition: 'base-type', value: 'REAL' } },
    { name: 'Kp', class: 'input', type: { definition: 'base-type', value: 'REAL' } },
    { name: 'Divisor', class: 'input', type: { definition: 'base-type', value: 'REAL' } },
  )
  if (pou.body.language !== 'fbd') throw new Error('expected FBD')
  pou.body.value.rung.nodes = [
    limitBlock, sub, mul, div, input('zero', '0.0', 0), input('hundred', '100.0', 100),
    readSP, readPV, readKP, readDivisor, destination,
  ]
  pou.body.value.rung.edges = [
    { id: 'e1', source: 'zero', target: 'limit', targetHandle: 'MN' },
    { id: 'e2', source: 'div', sourceHandle: 'OUT', target: 'limit', targetHandle: 'IN' },
    { id: 'e3', source: 'hundred', target: 'limit', targetHandle: 'MX' },
    { id: 'e4', source: 'limit', sourceHandle: 'OUT', target: 'out' },
    { id: 'e5', source: 'sp', target: 'sub', targetHandle: 'IN1' },
    { id: 'e6', source: 'pv', target: 'sub', targetHandle: 'IN2' },
    { id: 'e7', source: 'sub', sourceHandle: 'OUT', target: 'mul', targetHandle: 'IN1' },
    { id: 'e8', source: 'kp', target: 'mul', targetHandle: 'IN2' },
    { id: 'e9', source: 'mul', sourceHandle: 'OUT', target: 'div', targetHandle: 'IN1' },
    { id: 'e10', source: 'divisor', target: 'div', targetHandle: 'IN2' },
  ]
  return { pou, project }
}

describe('FBD arithmetic across imported untyped block signatures', () => {
  it('infers concrete REAL temporaries for SUB, MUL and DIV, including blocks before their input nodes', () => {
    const { pou, project } = pControllerWithImportedBlocks()
    const st = generateGraphicalPou(pou, project).map((chunk) => chunk[0]).join('')
    for (const declaration of ['_TMP_SUB3_OUT', '_TMP_MUL4_OUT', '_TMP_DIV6_OUT', '_TMP_LIMIT1_OUT']) {
      expect(st).toContain(`${declaration} : REAL;`)
    }
    expect(st).toContain('_TMP_SUB3_OUT := SUB(LevelSPPct, LevelPVPct);')
    expect(st).toContain('_TMP_MUL4_OUT := MUL(_TMP_SUB3_OUT, Kp);')
    expect(st).toContain('_TMP_DIV6_OUT := DIV(_TMP_MUL4_OUT, Divisor);')
    expect(st).toContain('DemandPct := _TMP_LIMIT1_OUT;')
    expect(st).not.toMatch(/_TMP_\w+\s*:\s*ANY(?:_\w+)?\s*;/)
  })

  it('fails with a clear diagnostic for a truly untyped function output, not invalid ST ANY', () => {
    const { pou, project } = pControllerWithImportedBlocks()
    if (pou.body.language !== 'fbd') throw new Error('expected FBD')
    pou.body.value.rung.nodes = [
      arithmetic('SUB', '3'), input('n1', '1.0', 10), input('n2', '2.0', 30),
    ]
    pou.body.value.rung.edges = [
      { id: 'e1', source: 'n1', target: 'sub', targetHandle: 'IN1' },
      { id: 'e2', source: 'n2', target: 'sub', targetHandle: 'IN2' },
    ]
    expect(() => generateGraphicalPou(pou, project)).toThrow('Cannot infer concrete IEC type for SUB.OUT')
  })
})


describe('Recovered arithmetic type safety', () => {
  it('recovers missing handle names from a partially restored library variant', () => {
    const block = arithmetic('MUL', '4')
    if (block.data.variant && typeof block.data.variant === 'object') {
      (block.data.variant as Record<string, unknown>).variables = [
        { name: 'IN1', class: 'input', type: { value: 'REAL' } },
      ]
    }
    expect(asBlockData(block.data)).toMatchObject({inputs: ['IN1', 'IN2'], outputs: ['OUT']})
  })

  it('rejects mixed REAL and BOOL on a homogeneous arithmetic operation', () => {
    const { pou, project } = pControllerWithImportedBlocks()
    pou.interface.variables.push({ name: 'Enabled', class: 'input', type: {definition:'base-type', value:'BOOL'} })
    if (pou.body.language !== 'fbd') throw new Error('expected FBD')
    pou.body.value.rung.nodes.push(input('enabled', 'Enabled', 400))
    const edge = pou.body.value.rung.edges.find((it) => it.target === 'mul' && it.targetHandle === 'IN2')
    if (!edge) throw new Error('missing MUL.IN2')
    edge.source = 'enabled'
    expect(() => generateGraphicalPou(pou, project)).toThrow('Conflicting IEC types for MUL')
  })

  it('recovers a BOOL result from a complete name-only GT signature', () => {
    const { pou, project } = pControllerWithImportedBlocks()
    if (pou.body.language !== 'fbd') throw new Error('expected FBD')
    const comparator = arithmetic('GT', '7')
    ;(comparator.data.variant as Record<string, unknown>).variables = [
      {name:'IN1',class:'input'}, {name:'IN2',class:'input'}, {name:'OUT',class:'output'},
    ]
    pou.interface.variables.push({ name: 'IsHigh', class: 'output', type: {definition:'base-type', value:'BOOL'} })
    pou.body.value.rung.nodes.push(comparator, {
      ...destination,
      id: 'gt-result',
      data: { numericId: '8', variant: 'output-variable', variable: { name: 'IsHigh' } },
    })
    pou.body.value.rung.edges.push(
      {id:'cmp1',source:'sp',target:'gt',targetHandle:'IN1'},
      {id:'cmp2',source:'pv',target:'gt',targetHandle:'IN2'},
      {id:'cmp3',source:'gt',sourceHandle:'OUT',target:'gt-result'},
    )
    const st = generateGraphicalPou(pou, project).map((chunk) => chunk[0]).join('')
    expect(st).toContain('_TMP_GT7_OUT : BOOL;')
    expect(st).toContain('_TMP_GT7_OUT := GT(LevelSPPct, LevelPVPct);')
    expect(st).toContain('IsHigh := _TMP_GT7_OUT;')
    expect(st).not.toContain('_TMP_GT7_OUT : REAL;')
  })

  it('recovers a BOOL result when a GT signature is entirely absent', () => {
    const { pou, project } = pControllerWithImportedBlocks()
    if (pou.body.language !== 'fbd') throw new Error('expected FBD')
    const comparator = arithmetic('GT', '7')
    pou.body.value.rung.nodes.push(comparator)
    pou.body.value.rung.edges.push(
      {id:'cmp1',source:'sp',target:'gt',targetHandle:'IN1'},
      {id:'cmp2',source:'pv',target:'gt',targetHandle:'IN2'},
    )
    const st = generateGraphicalPou(pou, project).map((chunk) => chunk[0]).join('')
    expect(st).toContain('_TMP_GT7_OUT : BOOL;')
    expect(st).toContain('_TMP_GT7_OUT := GT(LevelSPPct, LevelPVPct);')
    expect(st).not.toMatch(/_TMP_GT7_OUT\s*:\s*ANY(?:_\w+)?\s*;/)
  })

  it('still rejects a malformed GT with an unexpected third input pin', () => {
    const { pou, project } = pControllerWithImportedBlocks()
    if (pou.body.language !== 'fbd') throw new Error('expected FBD')
    const comparator = arithmetic('GT', '7')
    ;(comparator.data.inputHandles as Array<{id:string}>).push({id:'EXTRA'})
    pou.body.value.rung.nodes.push(comparator)
    pou.body.value.rung.edges.push(
      {id:'cmp1',source:'sp',target:'gt',targetHandle:'IN1'},
      {id:'cmp2',source:'pv',target:'gt',targetHandle:'IN2'},
    )
    expect(() => generateGraphicalPou(pou, project)).toThrow('Missing typed IEC signature for GT')
  })

})

// The JS generation assertions alone cannot detect ST unsupported by the
// native compiler. This is a required pre-pin acceptance test with the real
// STruC++ package (never mock compileStlib here).
describe('Native STruC++ acceptance for imported FBD arithmetic', () => {
  it('real STruC++ accepts the generated SUB/MUL/DIV/LIMIT program', () => {
    const { pou, project } = pControllerWithImportedBlocks()
    const st = generateGraphicalPou(pou, project).map((chunk) => chunk[0]).join('')
    const compiled = compileStlib(
      [{fileName: 'PumpRegulator.st', source: st}],
      { name: 'ces_fbd_arithmetic', version: '1.0.0', namespace: 'ces_fbd_arithmetic' },
    )
    if (!compiled.success) {
      throw new Error(`Native STruC++ rejected imported arithmetic: ${JSON.stringify(compiled.errors ?? [])}`)
    }
  })
})

import { generateGraphicalPou } from '@root/backend/shared/transpilers/st-transpiler/emit/pou-graphical'
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

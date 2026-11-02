import { computeConnectionTypes, pinIn, pinOut } from '../walker/connection-types'
import { blockInfosFromVariant } from '../helpers/block-library'
import { generateGraphicalPou } from '../emit/pou-graphical'
import type { TranspilePou, TranspileProject } from '../types'
import type { RFBody, RFNode, RFEdge } from '../walker/types'

const variable = (id: string, expression: string, kind = 'input-variable'): RFNode => ({
  id, type: kind, position: { x: 0, y: 0 },
  data: { numericId: id, variant: kind, variable: { name: expression } },
}) as RFNode

const block = (name: string, inputs: string[], id: string, outputs = ['OUT']): RFNode => ({
  id, type: 'block', position: { x: 200, y: 0 },
  data: {
    numericId: id, variable: { name }, executionOrder: 0, executionControl: false,
    variant: { name, type: 'function', variables: [] },
    inputHandles: inputs.map((pin) => ({ id: pin })),
    outputHandles: outputs.map((pin) => ({ id: pin })),
  },
}) as RFNode

const edge = (id: string, source: string, target: string, targetHandle?: string, sourceHandle?: string): RFEdge => ({
  id, source, target, ...(targetHandle ? { targetHandle } : {}), ...(sourceHandle ? { sourceHandle } : {}),
})

const infer = (nodes: RFNode[], edges: RFEdge[], vars: Record<string,string>) =>
  computeConnectionTypes({ rungs: [{ nodes, edges }] } as RFBody, {
    variableType: (expression) => vars[expression] ?? null,
    resolveBlock: () => null,
  })

describe('standard IEC FBD block signature recovery from PLCopen pin handles', () => {
  it.each(['LT', 'GT', 'LE', 'GE', 'EQ', 'NE'])(
    '%s recovers a BOOL output even when the imported signature has no variables', (name) => {
      const t = infer(
        [variable('a', 'PV'), variable('b', 'Threshold'), block(name, ['IN1','IN2'], 'cmp'), variable('out', 'Alarm', 'output-variable')],
        [edge('e1','a','cmp','IN1'), edge('e2','b','cmp','IN2'), edge('e3','cmp','out',undefined,'OUT')],
        { PV:'REAL', Threshold:'REAL', Alarm:'BOOL' },
      )
      expect(t.get(pinOut('cmp','OUT'))).toBe('BOOL')
      expect(t.get(pinIn('cmp','IN1'))).toBe('REAL')
      expect(t.get(pinIn('cmp','IN2'))).toBe('REAL')
    },
  )

  it('SEL keeps its BOOL guard independent of its REAL alternatives and output', () => {
    const t = infer(
      [variable('guard', 'DoReset'), variable('a', 'Low'), variable('b', 'High'), block('SEL', ['G','IN0','IN1'], 'sel'), variable('out', 'Target', 'output-variable')],
      [edge('e1','guard','sel','G'), edge('e2','a','sel','IN0'), edge('e3','b','sel','IN1'), edge('e4','sel','out',undefined,'OUT')],
      { DoReset:'BOOL', Low:'REAL', High:'REAL', Target:'REAL' },
    )
    expect(t.get(pinOut('sel','OUT'))).toBe('REAL')
    expect(t.get(pinIn('sel','G'))).toBe('BOOL')
  })

  it('emits a concrete REAL SEL temporary from a headless PLCopen-style FBD', () => {
    const nodes = [
      variable('g', 'Reset'), variable('lo', 'Low'), variable('hi', 'High'),
      block('SEL', ['G', 'IN0', 'IN1'], 'sel'), variable('out', 'Tracked', 'output-variable'),
    ]
    const edges = [
      edge('e1','g','sel','G'), edge('e2','lo','sel','IN0'), edge('e3','hi','sel','IN1'),
      edge('e4','sel','out',undefined,'OUT'),
    ]
    const vars = ['Reset', 'Low', 'High', 'Tracked'].map((name) => ({
      name,
      class: (name === 'Tracked' ? 'output' : 'input') as 'input' | 'output',
      type: { definition: 'base-type' as const, value: name === 'Reset' ? 'BOOL' : 'REAL' },
    }))
    const pou = {
      name: 'PumpRegulator', pouType: 'program', interface: { variables: vars },
      body: { language: 'fbd', value: { rung: { nodes, edges } } },
    } as TranspilePou
    const project = { pous: [pou], dataTypes: [], configurations: [] } as unknown as TranspileProject
    const st = generateGraphicalPou(pou, project).map((chunk) => chunk[0]).join('')
    expect(st).toContain('_TMP_SELsel_OUT : REAL;')
    expect(st).toContain('_TMP_SELsel_OUT := SEL(Reset, Low, High);')
    expect(st).toContain('Tracked := _TMP_SELsel_OUT;')
    expect(st).not.toMatch(/_TMP_SELsel_OUT\s*:\s*ANY(?:_\w+)?\s*;/)
  })

  it('rejects mixed operand types instead of guessing a conversion', () => {
    expect(() => infer(
      [variable('a','PV'), variable('b','Wrong'), block('LT', ['IN1','IN2'], 'lt')],
      [edge('e1','a','lt','IN1'), edge('e2','b','lt','IN2')],
      { PV:'REAL', Wrong:'BOOL' },
    )).toThrow(/Conflicting IEC operand types for LT/)
  })

  it('rejects a REAL-valued guard on generic SEL', () => {
    expect(() => infer(
      [variable('g','WrongGuard'), variable('a','Low'), variable('b','High'), block('SEL',['G','IN0','IN1'],'sel')],
      [edge('e1','g','sel','G'), edge('e2','a','sel','IN0'), edge('e3','b','sel','IN1')],
      { WrongGuard:'REAL', Low:'REAL', High:'REAL' },
    )).toThrow(/G must be BOOL/)
  })

  it('rejects a corrupted comparison signature that declares OUT as REAL', () => {
    const nodes = [variable('a', 'PV'), variable('b', 'Threshold'), block('LT', ['IN1','IN2'], 'lt')]
    const edges = [edge('e1','a','lt','IN1'), edge('e2','b','lt','IN2')]
    expect(() => computeConnectionTypes({ rungs: [{nodes,edges}] } as RFBody, {
      variableType: (expression) => ({PV:'REAL',Threshold:'REAL'} as Record<string,string>)[expression] ?? null,
      resolveBlock: () => ({
        name:'LT',type:'function',extensible:false,comment:'',usage:'',
        inputs:[
          { name:'IN1',type:'REAL',qualifier:'none' },
          { name:'IN2',type:'REAL',qualifier:'none' },
        ],
        outputs:[{name:'OUT',type:'REAL',qualifier:'none'}],
      }),
    })).toThrow(/OUT must be BOOL/)
  })

  it('rejects a partly restored comparison signature that explicitly claims a REAL OUT', () => {
    const malformed = block('GT', ['IN1','IN2'], 'gt')
    ;(malformed.data.variant as { variables: unknown[] }).variables = [
      { name: 'IN1', class: 'input' },
      { name: 'OUT', class: 'output', type: { value: 'REAL' } },
    ]
    expect(() => computeConnectionTypes({ rungs: [{
      nodes: [variable('a','PV'), variable('b','Threshold'), malformed],
      edges: [edge('e1','a','gt','IN1'), edge('e2','b','gt','IN2')],
    }] } as RFBody, {
      variableType: (expression) => ({PV:'REAL', Threshold:'REAL'} as Record<string,string>)[expression] ?? null,
      // Same project-variant resolution used by generateGraphicalPou.
      resolveBlock: () => blockInfosFromVariant(malformed.data.variant),
    })).toThrow(/OUT must be BOOL/)
  })

  it('does not infer semantics for an unrecognized or malformed block', () => {
    for (const name of ['CUSTOM_COMPARE', 'LT']) {
      const pins = name === 'LT' ? ['IN1','IN2','EXTRA'] : ['IN1','IN2']
      expect(() => infer([variable('a','PV'), block(name, pins, 'x')], [edge('e1','a','x','IN1')], {PV:'REAL'}))
        .toThrow(/Missing typed IEC signature/)
    }
  })
})

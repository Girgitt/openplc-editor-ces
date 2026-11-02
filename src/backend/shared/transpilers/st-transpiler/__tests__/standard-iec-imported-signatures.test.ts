import { computeConnectionTypes, pinIn, pinOut } from '../walker/connection-types'
import { blockInfosFromVariant } from '../helpers/block-library'
import { asBlockData } from '../walker/narrow'
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

// M7-E6 r4: one standard IEC ANY_BIT family contract instead of
// independent per-block fixes for NOT, AND, OR and XOR.
describe('imported standard IEC bit-string function family', () => {
  it.each(['NOT', 'AND', 'OR', 'XOR'])('%s recovers BOOL and bit-string signatures', (name) => {
    for (const type of ['BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD']) {
      const inputs = name === 'NOT' ? ['IN'] : ['IN1', 'IN2']
      const nodes = [variable('a', 'A'), block(name, inputs, 'op'), variable('out', 'Result', 'output-variable')]
      const edges = [edge('e1', 'a', 'op', inputs[0]), edge('e2', 'op', 'out', undefined, 'OUT')]
      if (name !== 'NOT') {
        nodes.splice(1, 0, variable('b', 'B'))
        edges.push(edge('e3', 'b', 'op', 'IN2'))
      }
      const result = infer(nodes, edges, { A: type, B: type, Result: type })
      expect(result.get(pinOut('op', 'OUT'))).toBe(type)
      expect(result.get(pinIn('op', inputs[0]))).toBe(type)
    }
  })

  it.each(['AND', 'OR', 'XOR'])('%s accepts three sequential, same-type input pins', (name) => {
    const result = infer(
      [variable('a', 'A'), variable('b', 'B'), variable('c', 'C'), block(name, ['IN1', 'IN2', 'IN3'], 'op'), variable('out', 'Result', 'output-variable')],
      [edge('e1', 'a', 'op', 'IN1'), edge('e2', 'b', 'op', 'IN2'), edge('e3', 'c', 'op', 'IN3'), edge('e4', 'op', 'out', undefined, 'OUT')],
      { A: 'BOOL', B: 'BOOL', C: 'BOOL', Result: 'BOOL' },
    )
    expect(result.get(pinOut('op', 'OUT'))).toBe('BOOL')
  })

  it.each([false, true])('propagates GT/LT to OR to NOT regardless of node ordering (reversed=%s)', (reverse) => {
    const nodes = [
      variable('pv', 'PV'), variable('hi', 'High'), variable('lo', 'Low'),
      block('GT', ['IN1','IN2'], 'gt'), block('LT', ['IN1','IN2'], 'lt'),
      block('OR', ['IN1','IN2'], 'or'), block('NOT', ['IN'], 'not'),
      variable('out', 'AutoEnable', 'output-variable'),
    ]
    if (reverse) nodes.reverse()
    const edges = [
      edge('e1','pv','gt','IN1'), edge('e2','hi','gt','IN2'),
      edge('e3','pv','lt','IN1'), edge('e4','lo','lt','IN2'),
      edge('e5','gt','or','IN1','OUT'), edge('e6','lt','or','IN2','OUT'),
      edge('e7','or','not','IN','OUT'), edge('e8','not','out',undefined,'OUT'),
    ]
    const result = infer(nodes, edges, { PV:'REAL', High:'REAL', Low:'REAL', AutoEnable:'BOOL' })
    for (const id of ['gt', 'lt', 'or', 'not']) {
      expect(result.get(pinOut(id, 'OUT'))).toBe('BOOL')
    }
  })

  it('compiles an imported OR followed by NOT into BOOL temporaries', () => {
    const nodes = [
      variable('a', 'A'), variable('b', 'B'),
      block('OR', ['IN1', 'IN2'], 'or'), block('NOT', ['IN'], 'not'),
      variable('out', 'Result', 'output-variable'),
    ]
    const edges = [
      edge('e1', 'a', 'or', 'IN1'), edge('e2', 'b', 'or', 'IN2'),
      edge('e3', 'or', 'not', 'IN', 'OUT'), edge('e4', 'not', 'out', undefined, 'OUT'),
    ]
    const vars = ['A', 'B', 'Result'].map((name) => ({
      name, class: (name === 'Result' ? 'output' : 'input') as 'output' | 'input',
      type: { definition: 'base-type' as const, value: 'BOOL' },
    }))
    const pou = { name: 'PumpRegulator', pouType: 'program', interface: { variables: vars }, body: { language: 'fbd', value: { rung: { nodes, edges } } } } as TranspilePou
    const project = { pous: [pou], dataTypes: [], configurations: [] } as unknown as TranspileProject
    const st = generateGraphicalPou(pou, project).map((chunk) => chunk[0]).join('')
    expect(st).toContain('_TMP_ORor_OUT : BOOL;')
    expect(st).toContain('_TMP_NOTnot_OUT : BOOL;')
    expect(st).toContain('_TMP_ORor_OUT := OR(A, B);')
    expect(st).toContain('_TMP_NOTnot_OUT := NOT(_TMP_ORor_OUT);')
  })

  it.each(['NOT', 'AND', 'OR', 'XOR'])('%s refuses REAL and mixed ANY_BIT inputs', (name) => {
    const pins = name === 'NOT' ? ['IN'] : ['IN1', 'IN2']
    const nodes = [variable('a', 'A'), variable('b', 'B'), block(name, pins, 'op')]
    const edges = [edge('e1', 'a', 'op', pins[0])]
    if (name !== 'NOT') edges.push(edge('e2', 'b', 'op', 'IN2'))
    expect(() => infer(nodes, edges, { A: 'REAL', B: 'REAL' })).toThrow(/expected ANY_BIT/)
    if (name !== 'NOT') {
      expect(() => infer(nodes, edges, { A: 'BOOL', B: 'BYTE' })).toThrow(/Conflicting IEC operand types/)
    }
  })

  it.each(['NOT', 'AND', 'OR', 'XOR'])('%s fails closed on unexpected pin names', (name) => {
    const inputs = name === 'NOT' ? ['INPUT'] : ['IN1', 'IN3']
    expect(() => infer([variable('a', 'A'), block(name, inputs, 'op')],
      [edge('e1', 'a', 'op', inputs[0])], { A: 'BOOL' }))
      .toThrow(/Missing typed IEC signature/)
  })

  it('rejects an explicitly contradictory bitwise library signature', () => {
    const corrupted = block('OR', ['IN1', 'IN2'], 'op')
    ;(corrupted.data.variant as { variables: unknown[] }).variables = [
      { name: 'IN1', class: 'input', type: { value: 'BOOL' } },
      { name: 'IN2', class: 'input', type: { value: 'BOOL' } },
      { name: 'OUT', class: 'output', type: { value: 'REAL' } },
    ]
    expect(() => computeConnectionTypes({rungs: [{
      nodes: [variable('a', 'A'), variable('b', 'B'), corrupted],
      edges: [edge('e1', 'a', 'op', 'IN1'), edge('e2', 'b', 'op', 'IN2')],
    }]} as RFBody, {
      variableType: (expression) => ({ A: 'BOOL', B: 'BOOL' } as Record<string,string>)[expression] ?? null,
      resolveBlock: () => blockInfosFromVariant(corrupted.data.variant),
    })).toThrow(/expected ANY_BIT/)
  })
})


// M7-E7 r4.1 audit: the typed persisted variant and the concrete wires must
// agree even if each side independently satisfies the IEC operator family.
describe('standard IEC imported typed-signature consistency', () => {
  const typed = (name: string, inputs: Array<[string, string]>, outputType: string) => ({
    name, type: 'function', extensible: false, comment: '', usage: '',
    inputs: inputs.map(([pin, type]) => ({ name: pin, type, qualifier: 'none' as const })),
    outputs: [{ name: 'OUT', type: outputType, qualifier: 'none' as const }],
  })

  it.each(['NOT', 'AND', 'OR', 'XOR'])('%s rejects a stale concrete BOOL variant applied to BYTE inputs', (name) => {
    const pins = name === 'NOT' ? ['IN'] : ['IN1', 'IN2']
    const b = block(name, pins, 'op')
    const nodes = [variable('a', 'A'), ...(pins.length > 1 ? [variable('b', 'B')] : []), b,
      variable('out', 'Result', 'output-variable')]
    const edges = [edge('e1', 'a', 'op', pins[0]),
      ...(pins.length > 1 ? [edge('e2', 'b', 'op', 'IN2')] : []),
      edge('e3', 'op', 'out', undefined, 'OUT')]
    expect(() => computeConnectionTypes({ rungs: [{ nodes, edges }] } as RFBody, {
      variableType: (expression) => ({A:'BYTE',B:'BYTE',Result:'BYTE'} as Record<string,string>)[expression] ?? null,
      resolveBlock: () => typed(name, pins.map((pin): [string,string] => [pin, 'BOOL']), 'BOOL'),
    })).toThrow(/IEC signature\/wire type mismatch/)
  })

  it.each(['GT', 'LT', 'LE', 'GE', 'EQ', 'NE'])('%s rejects an imported BOOL input that contradicts REAL wiring', (name) => {
    expect(() => computeConnectionTypes({ rungs: [{
      nodes: [variable('a', 'A'), variable('b', 'B'), block(name, ['IN1','IN2'], 'op')],
      edges: [edge('e1','a','op','IN1'),edge('e2','b','op','IN2')],
    }] } as RFBody, {
      variableType: () => 'REAL',
      resolveBlock: () => typed(name, [['IN1','REAL'],['IN2','BOOL']], 'BOOL'),
    })).toThrow(/IEC signature\/wire type mismatch/)
  })

  it('SEL rejects a stale BOOL alternative instead of silently using the REAL wire', () => {
    expect(() => computeConnectionTypes({ rungs: [{
      nodes: [variable('g','Guard'),variable('a','A'),variable('b','B'), block('SEL',['G','IN0','IN1'],'op')],
      edges: [edge('e0','g','op','G'),edge('e1','a','op','IN0'),edge('e2','b','op','IN1')],
    }] } as RFBody, {
      variableType: (expression) => expression === 'Guard' ? 'BOOL' : 'REAL',
      resolveBlock: () => typed('SEL', [['G','BOOL'],['IN0','BOOL'],['IN1','REAL']], 'REAL'),
    })).toThrow(/IEC signature\/wire type mismatch/)
  })

  it('retains genuinely compatible concrete library signatures', () => {
    const types = computeConnectionTypes({ rungs: [{
      nodes: [variable('a', 'A'), variable('b', 'B'), block('OR',['IN1','IN2'],'op'),variable('out','Result','output-variable')],
      edges: [edge('e1','a','op','IN1'),edge('e2','b','op','IN2'),edge('e3','op','out',undefined,'OUT')],
    }] } as RFBody, {
      variableType: () => 'WORD',
      resolveBlock: () => typed('OR', [['IN1','WORD'],['IN2','WORD']], 'WORD'),
    })
    expect(types.get(pinOut('op','OUT'))).toBe('WORD')
  })

  it.each(['GT', 'LT', 'SEL', 'OR', 'NOT'])('%s restores canonical positional argument order from partial variants', (name) => {
    const expected = name === 'SEL' ? ['G','IN0','IN1'] : name === 'NOT' ? ['IN'] : ['IN1','IN2']
    const raw = block(name, [...expected].reverse(), 'op')
    const variant = raw.data.variant as { variables: unknown[] }
    // An imported partially stamped variant lists one formal first; only
    // some input handles survive separately, often in a different order.
    variant.variables = [{ name: expected[expected.length-1], class: 'input' }]
    const data = asBlockData(raw.data)
    expect(data?.inputs).toEqual(expected)
  })

  it('recovers standard input signatures with optional EN/ENO control pins', () => {
    const b = block('OR', ['EN','IN1','IN2'], 'op', ['OUT','ENO'])
    b.data.executionControl = true
    const types = infer(
      [variable('en','Enable'),variable('a','A'),variable('b','B'),b,variable('out','Result','output-variable')],
      [edge('e0','en','op','EN'),edge('e1','a','op','IN1'),edge('e2','b','op','IN2'),edge('e3','op','out',undefined,'OUT')],
      {Enable:'BOOL',A:'BOOL',B:'BOOL',Result:'BOOL'},
    )
    expect(types.get(pinOut('op','OUT'))).toBe('BOOL')
  })

  it('preserves custom function pin ordering rather than sorting arbitrary formals', () => {
    const raw = block('MY_CUSTOM', ['Z', 'A'], 'op')
    expect(asBlockData(raw.data)?.inputs).toEqual(['Z','A'])
  })

  it('emits the correct SEL call when PLCopen pins arrive out of order', () => {
    const b = block('SEL', ['IN1','G','IN0'], 'sel')
    ;(b.data.variant as { variables: unknown[] }).variables = [{ name: 'IN1', class: 'input' }]
    const nodes = [variable('g', 'Guard'),variable('a','Low'),variable('b','High'),b,variable('o','Result','output-variable')]
    const edges = [edge('e1','g','sel','G'),edge('e2','a','sel','IN0'),edge('e3','b','sel','IN1'),edge('e4','sel','o',undefined,'OUT')]
    const vars = [
      { name:'Guard', class:'input',type:{definition:'base-type', value:'BOOL'} },
      ...['Low','High'].map((name) => ({name,class:'input',type:{definition:'base-type',value:'REAL'}})),
      { name:'Result',class:'output',type:{definition:'base-type',value:'REAL'} },
    ]
    const pou = { name:'P',pouType:'program',interface:{variables:vars},body:{language:'fbd',value:{rung:{nodes,edges}}} } as TranspilePou
    const project = { pous:[pou],dataTypes:[],configurations:[] } as unknown as TranspileProject
    const st = generateGraphicalPou(pou, project).map((chunk) => chunk[0]).join('')
    expect(st).toContain('SEL(Guard, Low, High)')
    expect(st).not.toContain('SEL(High, Guard, Low)')
  })
})

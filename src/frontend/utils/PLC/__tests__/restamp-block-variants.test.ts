import type { PLCVariable } from '../../../../middleware/shared/ports/types'
import type { SystemLibrary } from '../../../../middleware/shared/ports/library-types'
import { syncNodesWithVariables } from '../../graphical/sync-nodes-with-variables'
import { restampFlowBlockVariants } from '../restamp-block-variants'

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/** A system library whose ADR function now returns __XWORD (was ULINT). */
function makeSystemLibraries(): SystemLibrary[] {
  return [
    {
      name: 'STANDARD_FUNCTIONS',
      pous: [
        {
          name: 'ADR',
          type: 'function',
          language: 'st',
          body: '',
          documentation: '',
          variables: [
            { name: 'OUT', class: 'output', type: { definition: 'base-type', value: '__XWORD' } },
            { name: 'IN', class: 'input', type: { definition: 'generic-type', value: 'ANY' } },
          ],
        },
      ],
    },
  ] as unknown as SystemLibrary[]
}

/** A block node whose ADR variant is still stamped with the old ULINT return. */
function makeStaleAdrNode() {
  return {
    id: 'block-1',
    type: 'block',
    data: {
      variant: {
        name: 'ADR',
        type: 'function',
        language: 'st',
        body: '',
        documentation: '',
        variables: [
          { name: 'OUT', class: 'output', type: { definition: 'base-type', value: 'ULINT' } },
          { name: 'IN', class: 'input', type: { definition: 'generic-type', value: 'ANY' } },
        ],
      },
    },
  }
}

/** A project function block whose IN1 pin is typed MyStruct. */
function makeUserPou(
  name: string,
  variables: Array<{ name: string; class: string; definition: string; value: string }>,
  options: { pouType?: string; returnType?: string } = {},
) {
  return {
    name,
    pouType: options.pouType ?? 'function-block',
    body: { language: 'st', value: '' },
    interface: {
      ...(options.returnType ? { returnType: options.returnType } : {}),
      variables: variables.map((variable) => ({
        name: variable.name,
        class: variable.class,
        type: { definition: variable.definition, value: variable.value },
      })),
    },
  } as unknown as Parameters<typeof restampFlowBlockVariants>[2][number]
}

/** A placed user FB whose IN1 pin is still stamped with the old type. */
function makeStaleUserBlockNode(pinValue = 'OLDSTRUCT') {
  return {
    id: 'block-1',
    type: 'block',
    data: {
      variant: {
        name: 'MyFB',
        type: 'function-block',
        variables: [{ name: 'IN1', class: 'input', type: { definition: 'user-data-type', value: pinValue } }],
      },
    },
  }
}

/** The ladder pin node that connects a variable to that block's IN1 pin. */
function makePinNode(pinValue = 'OLDSTRUCT') {
  return {
    id: 'pin-1',
    type: 'variable',
    data: {
      variable: { name: 'motor' },
      variant: 'input',
      block: {
        id: 'block-1',
        handleId: 'IN1',
        variableType: { name: 'IN1', class: 'input', type: { definition: 'user-data-type', value: pinValue } },
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('restampFlowBlockVariants', () => {
  it('hydrates an imported PLCopen block whose variant has no typed signature', () => {
    const node = makeStaleAdrNode()
    node.data.variant.variables = []
    const flow = { rung: { nodes: [node] } }

    const changed = restampFlowBlockVariants([flow], makeSystemLibraries(), [])

    expect(changed).toBe(2)
    expect(node.data.variant.variables.map((variable) => [variable.name, variable.class, variable.type.value])).toEqual([
      ['OUT', 'output', '__XWORD'],
      ['IN', 'input', 'ANY'],
    ])
  })



  it('separates stacked PLCopen FBD handles while preserving their semantic target ports', () => {
    const systemLibraries = [
      {
        name: 'STANDARD_FUNCTION_BLOCKS',
        pous: [
          {
            name: 'RS',
            type: 'function-block',
            language: 'st',
            body: '',
            documentation: '',
            variables: [
              { name: 'S', class: 'input', type: { definition: 'base-type', value: 'BOOL' } },
              { name: 'R1', class: 'input', type: { definition: 'base-type', value: 'BOOL' } },
              { name: 'Q1', class: 'output', type: { definition: 'base-type', value: 'BOOL' } },
            ],
          },
        ],
      },
    ] as unknown as SystemLibrary[]

    const makeInput = (id: string) => ({
      id,
      type: 'target',
      position: 'left',
      glbPosition: { x: 200, y: 148 },
      relPosition: { x: 0, y: 48 },
      style: { top: 48, left: 0 },
    })
    const outputHandle = {
      id: 'Q1',
      type: 'source',
      position: 'right',
      glbPosition: { x: 300, y: 148 },
      relPosition: { x: 100, y: 48 },
      style: { top: 48, right: 0 },
    }
    const sHandle = makeInput('S')
    const rHandle = makeInput('R1')
    const node = {
      id: 'rs-block',
      type: 'block',
      position: { x: 200, y: 100 },
      width: 100,
      height: 72,
      data: {
        variant: { name: 'RS', type: 'function-block', variables: [] },
        handles: [sHandle, rHandle, outputHandle],
        inputHandles: [sHandle, rHandle],
        outputHandles: [outputHandle],
        inputConnector: sHandle,
        outputConnector: outputHandle,
      },
    }
    const flow = {
      rung: {
        nodes: [node],
        edges: [
          { id: 'set', source: 'set-source', target: 'rs-block', sourceHandle: 'out', targetHandle: 'S' },
          { id: 'reset', source: 'reset-source', target: 'rs-block', sourceHandle: 'out', targetHandle: 'R1' },
        ],
      },
    }

    restampFlowBlockVariants([flow], systemLibraries, [])

    expect(node.data.inputHandles.map((handle) => handle.id)).toEqual(['S', 'R1'])
    expect(node.data.inputHandles.map((handle) => handle.relPosition.y)).toEqual([48, 96])
    expect(flow.rung.edges.map((edge) => edge.targetHandle)).toEqual(['S', 'R1'])
    expect(node.height).toBeGreaterThanOrEqual(120)
  })

  it('installs render positions on parser-shaped PLCopen handles that already have distinct geometry', () => {
    const systemLibraries = [
      {
        name: 'STANDARD_FUNCTION_BLOCKS',
        pous: [
          {
            name: 'RS',
            type: 'function-block',
            language: 'st',
            body: '',
            documentation: '',
            variables: [
              { name: 'S', class: 'input', type: { definition: 'base-type', value: 'BOOL' } },
              { name: 'R1', class: 'input', type: { definition: 'base-type', value: 'BOOL' } },
              { name: 'Q1', class: 'output', type: { definition: 'base-type', value: 'BOOL' } },
            ],
          },
        ],
      },
    ] as unknown as SystemLibrary[]

    // XML parsing reconstructs the semantic geometry but not ReactFlow's CSS
    // placement. M5-3 used to calculate these styles and then discard them
    // because its equality test ignored style, leaving S/R1 visually stacked.
    const sHandle = {
      id: 'S',
      type: 'target',
      position: 'left',
      glbPosition: { x: 200, y: 148 },
      relPosition: { x: 0, y: 48 },
      style: undefined,
    }
    const rHandle = {
      id: 'R1',
      type: 'target',
      position: 'left',
      glbPosition: { x: 200, y: 196 },
      relPosition: { x: 0, y: 96 },
      style: undefined,
    }
    const outputHandle = {
      id: 'Q1',
      type: 'source',
      position: 'right',
      glbPosition: { x: 300, y: 148 },
      relPosition: { x: 100, y: 48 },
      style: undefined,
    }
    const node = {
      id: 'rs-block',
      type: 'block',
      position: { x: 200, y: 100 },
      width: 100,
      height: 120,
      data: {
        variant: { name: 'RS', type: 'function-block', variables: [] },
        handles: [sHandle, rHandle, outputHandle],
        inputHandles: [sHandle, rHandle],
        outputHandles: [outputHandle],
        inputConnector: undefined,
        outputConnector: undefined,
      },
    }
    const flow = {
      rung: {
        nodes: [node],
        edges: [
          { id: 'set', source: 'set-source', target: 'rs-block', sourceHandle: 'out', targetHandle: 'S' },
          { id: 'reset', source: 'reset-source', target: 'rs-block', sourceHandle: 'out', targetHandle: 'R1' },
        ],
      },
    }

    restampFlowBlockVariants([flow], systemLibraries, [])

    expect(node.data.inputHandles.map((handle) => handle.id)).toEqual(['S', 'R1'])
    expect(node.data.inputHandles.map((handle) => handle.style)).toEqual([
      { top: 48, left: 0 },
      { top: 96, left: 0 },
    ])
    expect(node.data.outputHandles[0].style).toEqual({ top: 48, right: 0 })
    expect(node.data.handles.map((handle) => handle.style?.top)).toEqual([48, 96, 48])
    expect(flow.rung.edges.map((edge) => edge.targetHandle)).toEqual(['S', 'R1'])
  })

  it('repairs a hydrated PLCopen FBD block whose inputs collapsed onto one handle', () => {
    const systemLibraries = [
      {
        name: 'STANDARD_FUNCTION_BLOCKS',
        pous: [
          {
            name: 'RS',
            type: 'function-block',
            language: 'st',
            body: '',
            documentation: '',
            variables: [
              { name: 'S', class: 'input', type: { definition: 'base-type', value: 'BOOL' } },
              { name: 'R1', class: 'input', type: { definition: 'base-type', value: 'BOOL' } },
              { name: 'Q1', class: 'output', type: { definition: 'base-type', value: 'BOOL' } },
            ],
          },
        ],
      },
    ] as unknown as SystemLibrary[]

    const inputHandle = {
      id: 'S',
      type: 'target',
      position: 'left',
      glbPosition: { x: 200, y: 148 },
      relPosition: { x: 0, y: 48 },
      style: { top: 48, left: 0 },
    }
    const outputHandle = {
      id: 'Q1',
      type: 'source',
      position: 'right',
      glbPosition: { x: 300, y: 148 },
      relPosition: { x: 100, y: 48 },
      style: { top: 48, right: 0 },
    }
    const node = {
      id: 'rs-block',
      type: 'block',
      position: { x: 200, y: 100 },
      width: 100,
      height: 120,
      data: {
        variant: { name: 'RS', type: 'function-block', variables: [] },
        handles: [inputHandle, outputHandle],
        inputHandles: [inputHandle],
        outputHandles: [outputHandle],
        inputConnector: inputHandle,
        outputConnector: outputHandle,
      },
    }
    const flow = {
      rung: {
        nodes: [node],
        edges: [
          { id: 'set', source: 'set-source', target: 'rs-block', sourceHandle: 'out', targetHandle: 'S' },
          { id: 'reset', source: 'reset-source', target: 'rs-block', sourceHandle: 'out', targetHandle: 'S' },
        ],
      },
    }

    restampFlowBlockVariants([flow], systemLibraries, [])

    expect(node.data.variant.variables.map((variable) => variable.name)).toEqual(['S', 'R1', 'Q1'])
    expect(node.data.inputHandles.map((handle) => handle.id)).toEqual(['S', 'R1'])
    expect(node.data.handles.filter((handle) => handle.type === 'target').map((handle) => handle.id)).toEqual(['S', 'R1'])
    expect(node.data.inputHandles[0].relPosition.y).not.toBe(node.data.inputHandles[1].relPosition.y)
    expect(flow.rung.edges.map((edge) => edge.targetHandle)).toEqual(['S', 'R1'])
  })

  it('refreshes a stale library block return type (ADR ULINT -> __XWORD)', () => {
    const node = makeStaleAdrNode()
    const flow = { rung: { nodes: [node] } }

    const changed = restampFlowBlockVariants([flow], makeSystemLibraries(), [])

    expect(changed).toBe(1)
    expect(node.data.variant.variables.find((v) => v.name === 'OUT')!.type.value).toBe('__XWORD')
  })

  it('walks every rung of a ladder flow', () => {
    const node = makeStaleAdrNode()
    const flow = { rungs: [{ nodes: [] }, { nodes: [node] }] }

    const changed = restampFlowBlockVariants([flow], makeSystemLibraries(), [])

    expect(changed).toBe(1)
    expect(node.data.variant.variables[0].type.value).toBe('__XWORD')
  })

  it('lets a user-defined POU win over a library entry of the same name', () => {
    // A user POU named "ADR" (contrived): the project owns its own interface,
    // so its return type is stamped, not the library's __XWORD.
    const node = makeStaleAdrNode()
    const flow = { rung: { nodes: [node] } }

    const changed = restampFlowBlockVariants([flow], makeSystemLibraries(), [
      makeUserPou('ADR', [], { pouType: 'function', returnType: 'DINT' }),
    ])

    expect(changed).toBe(1)
    expect(node.data.variant.variables[0].type.value).toBe('DINT')
  })

  it('leaves up-to-date variants untouched (no spurious changes)', () => {
    const node = makeStaleAdrNode()
    node.data.variant.variables[0].type.value = '__XWORD'
    const flow = { rung: { nodes: [node] } }

    const changed = restampFlowBlockVariants([flow], makeSystemLibraries(), [])

    expect(changed).toBe(0)
  })

  it('ignores blocks not present in any library (user blocks, unknown types)', () => {
    const node = makeStaleAdrNode()
    node.data.variant.name = 'MY_CUSTOM_FB'
    const flow = { rung: { nodes: [node] } }

    const changed = restampFlowBlockVariants([flow], makeSystemLibraries(), [])

    expect(changed).toBe(0)
    expect(node.data.variant.variables[0].type.value).toBe('ULINT')
  })

  it('is a no-op when neither a library nor a project POU defines the block', () => {
    const node = makeStaleAdrNode()
    const flow = { rung: { nodes: [node] } }

    const changed = restampFlowBlockVariants([flow], [], [])

    expect(changed).toBe(0)
    expect(node.data.variant.variables[0].type.value).toBe('ULINT')
  })
})

describe('restampFlowBlockVariants — blocks backed by a project POU', () => {
  it('refreshes a stale user function-block pin type from the POU interface', () => {
    const node = makeStaleUserBlockNode()
    const flow = { rung: { nodes: [node] } }

    const changed = restampFlowBlockVariants(
      [flow],
      [],
      [makeUserPou('MyFB', [{ name: 'IN1', class: 'input', definition: 'user-data-type', value: 'MyStruct' }])],
    )

    expect(changed).toBe(1)
    expect(node.data.variant.variables[0].type).toEqual({ definition: 'user-data-type', value: 'MYSTRUCT' })
  })

  it("follows the POU's return type for a function's OUT pin", () => {
    const node = makeStaleUserBlockNode()
    node.data.variant.name = 'MyFn'
    node.data.variant.type = 'function'
    node.data.variant.variables = [
      { name: 'OUT', class: 'output', type: { definition: 'base-type', value: 'INT' } },
    ] as unknown as typeof node.data.variant.variables
    const flow = { rung: { nodes: [node] } }

    const changed = restampFlowBlockVariants(
      [flow],
      [],
      [makeUserPou('MyFn', [], { pouType: 'function', returnType: 'REAL' })],
    )

    expect(changed).toBe(1)
    expect(node.data.variant.variables[0].type.value).toBe('REAL')
  })

  it('leaves pins the interface no longer declares alone (EN/ENO, removed pins)', () => {
    const node = makeStaleUserBlockNode()
    node.data.variant.variables = [
      { name: 'EN', class: 'input', type: { definition: 'base-type', value: 'BOOL' } },
      { name: 'GONE', class: 'input', type: { definition: 'base-type', value: 'INT' } },
    ] as unknown as typeof node.data.variant.variables
    const flow = { rung: { nodes: [node] } }

    const changed = restampFlowBlockVariants(
      [flow],
      [],
      [makeUserPou('MyFB', [{ name: 'IN1', class: 'input', definition: 'base-type', value: 'REAL' }])],
    )

    expect(changed).toBe(0)
    expect(node.data.variant.variables.map((variable) => variable.name)).toEqual(['EN', 'GONE'])
  })

  it('never adds a pin the interface gained (that needs the node rebuilt)', () => {
    const node = makeStaleUserBlockNode()
    const flow = { rung: { nodes: [node] } }

    restampFlowBlockVariants(
      [flow],
      [],
      [
        makeUserPou('MyFB', [
          { name: 'IN1', class: 'input', definition: 'user-data-type', value: 'MyStruct' },
          { name: 'IN2', class: 'input', definition: 'base-type', value: 'INT' },
        ]),
      ],
    )

    expect(node.data.variant.variables).toHaveLength(1)
  })

  it('matches the POU name case-insensitively, as IEC identifiers are', () => {
    const node = makeStaleUserBlockNode()
    const flow = { rung: { nodes: [node] } }

    const changed = restampFlowBlockVariants(
      [flow],
      [],
      [makeUserPou('myfb', [{ name: 'in1', class: 'input', definition: 'user-data-type', value: 'MyStruct' }])],
    )

    expect(changed).toBe(1)
    expect(node.data.variant.variables[0].type.value).toBe('MYSTRUCT')
  })

  it('leaves an up-to-date user block untouched', () => {
    const node = makeStaleUserBlockNode('MYSTRUCT')
    const flow = { rung: { nodes: [node] } }

    const changed = restampFlowBlockVariants(
      [flow],
      [],
      [makeUserPou('MyFB', [{ name: 'IN1', class: 'input', definition: 'user-data-type', value: 'MyStruct' }])],
    )

    expect(changed).toBe(0)
  })
})

describe('restampFlowBlockVariants — malformed or oddly cased data', () => {
  it('matches a library POU name case-insensitively', () => {
    const node = makeStaleAdrNode()
    node.data.variant.name = 'adr'
    const flow = { rung: { nodes: [node] } }

    const changed = restampFlowBlockVariants([flow], makeSystemLibraries(), [])

    expect(changed).toBe(1)
    expect(node.data.variant.variables[0].type.value).toBe('__XWORD')
  })

  it('skips a block whose persisted variant has no variables array', () => {
    const node = makeStaleAdrNode()
    delete (node.data.variant as { variables?: unknown }).variables
    const flow = { rung: { nodes: [node] } }

    expect(() => restampFlowBlockVariants([flow], makeSystemLibraries(), [])).not.toThrow()
  })

  it('skips a pin node whose block variant has no variables array', () => {
    const blockNode = makeStaleUserBlockNode()
    delete (blockNode.data.variant as { variables?: unknown }).variables
    const pinNode = makePinNode()
    const flow = { rung: { nodes: [blockNode, pinNode] } }

    expect(() =>
      restampFlowBlockVariants(
        [flow],
        [],
        [makeUserPou('MyFB', [{ name: 'IN1', class: 'input', definition: 'user-data-type', value: 'MyStruct' }])],
      ),
    ).not.toThrow()
    expect(pinNode.data.block.variableType.type.value).toBe('OLDSTRUCT')
  })
})

describe('restampFlowBlockVariants — ladder pin nodes', () => {
  it("refreshes the pin node's cached type from the block it connects to", () => {
    const pinNode = makePinNode()
    const flow = { rung: { nodes: [makeStaleUserBlockNode(), pinNode] } }

    restampFlowBlockVariants(
      [flow],
      [],
      [makeUserPou('MyFB', [{ name: 'IN1', class: 'input', definition: 'user-data-type', value: 'MyStruct' }])],
    )

    expect(pinNode.data.block.variableType.type).toEqual({ definition: 'user-data-type', value: 'MYSTRUCT' })
  })

  it('refreshes a pin node whose block is a library block', () => {
    const blockNode = makeStaleAdrNode()
    const pinNode = makePinNode('ULINT')
    pinNode.data.block.handleId = 'OUT'
    pinNode.data.block.variableType = {
      name: 'OUT',
      class: 'output',
      type: { definition: 'base-type', value: 'ULINT' },
    } as unknown as typeof pinNode.data.block.variableType
    const flow = { rung: { nodes: [blockNode, pinNode] } }

    restampFlowBlockVariants([flow], makeSystemLibraries(), [])

    expect(pinNode.data.block.variableType.type.value).toBe('__XWORD')
  })

  it('leaves a pin node whose block is not in the rung alone', () => {
    const pinNode = makePinNode()
    const flow = { rung: { nodes: [pinNode] } }

    const changed = restampFlowBlockVariants(
      [flow],
      [],
      [makeUserPou('MyFB', [{ name: 'IN1', class: 'input', definition: 'user-data-type', value: 'MyStruct' }])],
    )

    expect(changed).toBe(0)
    expect(pinNode.data.block.variableType.type.value).toBe('OLDSTRUCT')
  })
})

describe('DOPE-548 — a user FB pin type change must not break a linked variable', () => {
  it('leaves the link intact once the block and its pin node are re-stamped', () => {
    const flow = {
      name: 'Prog',
      rungs: [{ id: 'r1', nodes: [makeStaleUserBlockNode(), makePinNode()], edges: [] }],
    }
    // The FB now declares IN1 : MyStruct, and the POU variable follows it.
    const userPous = [
      makeUserPou('MyFB', [{ name: 'IN1', class: 'input', definition: 'user-data-type', value: 'MyStruct' }]),
    ]
    const variables = [
      { id: '1', name: 'motor', type: { definition: 'user-data-type', value: 'MYSTRUCT' } },
    ] as unknown as PLCVariable[]

    restampFlowBlockVariants([flow], [], userPous)

    const updateNodes = vi.fn()
    syncNodesWithVariables(variables, [flow] as unknown as Parameters<typeof syncNodesWithVariables>[1], updateNodes)

    // Without the re-stamp the pin still reads OLDSTRUCT and the node is
    // replaced by a broken-… payload flagged wrongVariable.
    expect(updateNodes).not.toHaveBeenCalled()
  })
})

import { BlockNode } from '@root/frontend/components/_atoms/graphical-editor/fbd/block'
import type { VariableNode } from '@root/frontend/components/_atoms/graphical-editor/fbd/utils/types'
import type { BlockVariant } from '@root/frontend/components/_atoms/graphical-editor/types/block'

import { parseFbdXml } from '../fbd-xml'
import { fbdToXml } from '../../../xml-generator/old-editor/language/fbd-xml'

describe('parseFbdXml', () => {
  it('preserves both connected RS inputs across repeated PLCopen round trips', () => {
    const source = (id: string, name: string, y: number) => ({
      '@localId': id,
      '@executionOrderId': '0',
      '@width': '80',
      '@height': '32',
      position: { '@x': '20', '@y': String(y) },
      connectionPointOut: { relPosition: { '@x': '80', '@y': '16' } },
      expression: name,
    })
    const fbd = {
      inVariable: [source('1', 'v1', 0), source('2', 'v2', 60)],
      block: [{
        '@localId': '3',
        '@typeName': 'RS',
        '@instanceName': 'RS0',
        '@executionOrderId': '1',
        '@width': '90',
        '@height': '120',
        position: { '@x': '200', '@y': '0' },
        inputVariables: { variable: [
          {
            '@formalParameter': 'S',
            connectionPointIn: {
              relPosition: { '@x': '0', '@y': '48' },
              connection: [{ '@refLocalId': '1', '@formalParameter': '' }],
            },
          },
          {
            '@formalParameter': 'R1',
            connectionPointIn: {
              relPosition: { '@x': '0', '@y': '96' },
              connection: [{ '@refLocalId': '2' }],
            },
          },
        ] },
        outputVariables: { variable: [{
          '@formalParameter': 'Q1',
          connectionPointOut: { relPosition: { '@x': '90', '@y': '48' } },
        }] },
      }],
    }
    let parsed = parseFbdXml('rs-test', fbd)
    for (let i = 0; i < 2; i += 1) {
      expect(parsed.warnings).toEqual([])
      expect(parsed.body.rung.edges.map((edge) => [edge.sourceHandle, edge.targetHandle])).toEqual([
        ['output-variable', 'S'], ['output-variable', 'R1'],
      ])
      const serialized = fbdToXml(parsed.body.rung).body.FBD
      expect(serialized.block[0].inputVariables.variable.map((variable) => [
        variable['@formalParameter'], variable.connectionPointIn.connection[0]?.['@refLocalId'],
      ])).toEqual([['S', '1'], ['R1', '2']])
      parsed = parseFbdXml('rs-test', serialized)
    }
  })

  it('returns an empty rung for an empty FBD body', () => {
    const { body, warnings } = parseFbdXml('empty', {})
    expect(warnings).toEqual([])
    expect(body).toEqual({
      name: 'empty',
      updated: false,
      rung: { comment: '', nodes: [], edges: [], selectedNodes: [] },
    })
  })

  it('parses an input-variable node', () => {
    const { body } = parseFbdXml('p', {
      inVariable: [
        {
          '@localId': '1',
          '@executionOrderId': '0',
          '@width': '80',
          '@height': '30',
          '@negated': 'false',
          position: { '@x': '0', '@y': '0' },
          connectionPointOut: { relPosition: { '@x': '80', '@y': '15' } },
          expression: 'X1',
        },
      ],
    })
    const node = body.rung.nodes[0] as VariableNode
    expect(node.id).toBe('INPUT-VARIABLE-1')
    expect(node.type).toBe('input-variable')
    expect(node.data.variable).toEqual({ name: 'X1' })
    expect(node.data.negated).toBe(false)
    expect(node.data.outputHandles[0].id).toBe('output-variable')
    expect(node.data.outputHandles[0].relPosition).toEqual({ x: 80, y: 15 })
    expect(node.data.outputHandles[0].style).toEqual({ top: 15, right: 0 })
  })

  it('repairs stale variable connector geometry to the centre of its edge', () => {
    const { body } = parseFbdXml('p', {
      inVariable: [
        {
          '@localId': '1',
          '@executionOrderId': '0',
          '@width': '80',
          '@height': '32',
          '@negated': 'false',
          position: { '@x': '10', '@y': '20' },
          connectionPointOut: { relPosition: { '@x': '80', '@y': '0' } },
          expression: 'Source',
        },
      ],
      outVariable: [
        {
          '@localId': '2',
          '@executionOrderId': '1',
          '@width': '80',
          '@height': '32',
          '@negated': 'false',
          position: { '@x': '200', '@y': '20' },
          connectionPointIn: { relPosition: { '@x': '0', '@y': '0' } },
          expression: 'Sink',
        },
      ],
    })
    const [source, sink] = body.rung.nodes as VariableNode[]

    expect(source.data.outputConnector?.relPosition).toEqual({ x: 80, y: 16 })
    expect(source.data.outputConnector?.style).toEqual({ top: 16, right: 0 })
    expect(sink.data.inputConnector?.relPosition).toEqual({ x: 0, y: 16 })
    expect(sink.data.inputConnector?.style).toEqual({ top: 16, left: 0 })
  })

  it('widens an imported variable box narrower than the minimum, moving the output pin with it', () => {
    const { body } = parseFbdXml('p', {
      inVariable: [
        {
          '@localId': '1',
          '@executionOrderId': '0',
          '@width': '40',
          '@height': '30',
          '@negated': 'false',
          position: { '@x': '100', '@y': '0' },
          connectionPointOut: { relPosition: { '@x': '40', '@y': '15' } },
          expression: 'X1',
        },
      ],
      outVariable: [
        {
          '@localId': '2',
          '@executionOrderId': '1',
          '@width': '40',
          '@height': '30',
          '@negated': 'false',
          position: { '@x': '300', '@y': '0' },
          connectionPointIn: { relPosition: { '@x': '0', '@y': '15' } },
          expression: 'Y1',
        },
      ],
    })
    const [input, output] = body.rung.nodes as VariableNode[]

    expect(input.width).toBe(64)
    expect(input.position).toEqual({ x: 100, y: 0 })
    expect(input.data.outputConnector?.relPosition).toEqual({ x: 64, y: 15 })
    expect(input.data.outputConnector?.glbPosition).toEqual({ x: 164, y: 15 })
    expect(input.data.handles[0]).toEqual(input.data.outputConnector)

    // The input pin is on the left edge, which does not move.
    expect(output.width).toBe(64)
    expect(output.data.inputConnector?.relPosition).toEqual({ x: 0, y: 15 })
    expect(output.data.inputConnector?.glbPosition).toEqual({ x: 300, y: 15 })
  })

  it('keeps an imported variable width at or above the minimum as is', () => {
    const { body } = parseFbdXml('p', {
      inVariable: [
        {
          '@localId': '1',
          '@executionOrderId': '0',
          '@width': '90',
          '@height': '30',
          '@negated': 'false',
          position: { '@x': '0', '@y': '0' },
          connectionPointOut: { relPosition: { '@x': '90', '@y': '15' } },
          expression: 'X1',
        },
      ],
    })
    const node = body.rung.nodes[0] as VariableNode
    expect(node.width).toBe(90)
    expect(node.data.outputConnector?.relPosition).toEqual({ x: 90, y: 15 })
  })

  it('parses an output-variable node and resolves its connection into an edge', () => {
    const { body, warnings } = parseFbdXml('p', {
      inVariable: [
        {
          '@localId': '1',
          '@executionOrderId': '0',
          '@width': '80',
          '@height': '30',
          '@negated': 'false',
          position: { '@x': '0', '@y': '0' },
          connectionPointOut: { relPosition: { '@x': '80', '@y': '15' } },
          expression: 'X1',
        },
      ],
      outVariable: [
        {
          '@localId': '2',
          '@executionOrderId': '1',
          '@width': '80',
          '@height': '30',
          '@negated': 'true',
          position: { '@x': '200', '@y': '0' },
          connectionPointIn: {
            relPosition: { '@x': '0', '@y': '15' },
            connection: [{ '@refLocalId': '1' }],
          },
          expression: 'Y1',
        },
      ],
    })
    expect(warnings).toEqual([])
    expect(body.rung.nodes).toHaveLength(2)
    expect(body.rung.edges).toEqual([
      {
        id: 'xy-edge__INPUT-VARIABLE-1output-variable-OUTPUT-VARIABLE-2input-variable',
        source: 'INPUT-VARIABLE-1',
        sourceHandle: 'output-variable',
        target: 'OUTPUT-VARIABLE-2',
        targetHandle: 'input-variable',
        type: 'smoothstep',
      },
    ])
    const outNode = body.rung.nodes[1]
    expect(outNode.data.negated).toBe(true)
  })

  it('parses a block with a function-block instance name and deduped input handles', () => {
    const { body } = parseFbdXml('p', {
      block: [
        {
          '@localId': '3',
          '@typeName': 'TON',
          '@instanceName': 'ton1',
          '@executionOrderId': '2',
          '@width': '100',
          '@height': '60',
          position: { '@x': '50', '@y': '50' },
          inputVariables: {
            variable: [
              {
                '@formalParameter': 'IN',
                connectionPointIn: { relPosition: { '@x': '0', '@y': '10' }, connection: [{ '@refLocalId': '1' }] },
              },
              {
                // Same formalParameter, second incoming edge — must be deduped to one handle.
                '@formalParameter': 'IN',
                connectionPointIn: { relPosition: { '@x': '0', '@y': '10' }, connection: [{ '@refLocalId': '2' }] },
              },
            ],
          },
          outputVariables: {
            variable: [{ '@formalParameter': 'Q', connectionPointOut: { relPosition: { '@x': '100', '@y': '10' } } }],
          },
        },
      ],
    })
    const node = body.rung.nodes[0] as BlockNode<BlockVariant>
    expect(node.id).toBe('BLOCK-3')
    expect(node.data.inputHandles).toHaveLength(1)
    expect(node.data.variable).toEqual({ name: 'ton1' })
    expect(node.data.variant.type).toBe('function-block')
  })

  it('parses a block that is a plain function call (no @instanceName)', () => {
    const { body } = parseFbdXml('p', {
      block: [
        {
          '@localId': '4',
          '@typeName': 'ADD',
          '@executionOrderId': '0',
          '@width': '60',
          '@height': '40',
          position: { '@x': '0', '@y': '0' },
          inputVariables: '',
          outputVariables: '',
        },
      ],
    })
    const node = body.rung.nodes[0] as BlockNode<BlockVariant>
    expect(node.data.variable).toEqual({ name: 'ADD' })
    expect(node.data.variant.type).toBe('function')
  })

  it('parses a connector/continuation pair', () => {
    const { body } = parseFbdXml('p', {
      connector: [
        {
          '@name': 'c1',
          '@localId': '5',
          '@width': '40',
          '@height': '20',
          position: { '@x': '0', '@y': '0' },
          connectionPointIn: { relPosition: { '@x': '0', '@y': '10' }, connection: [{ '@refLocalId': '1' }] },
        },
      ],
      continuation: [
        {
          '@name': 'c1',
          '@localId': '6',
          '@width': '40',
          '@height': '20',
          position: { '@x': '100', '@y': '0' },
          connectionPointOut: { relPosition: { '@x': '40', '@y': '10' } },
        },
      ],
      inVariable: [
        {
          '@localId': '1',
          '@executionOrderId': '0',
          '@width': '80',
          '@height': '30',
          '@negated': 'false',
          position: { '@x': '0', '@y': '0' },
          connectionPointOut: { relPosition: { '@x': '80', '@y': '15' } },
          expression: 'X1',
        },
      ],
    })
    const connector = body.rung.nodes.find((n) => n.type === 'connector')
    const continuation = body.rung.nodes.find((n) => n.type === 'continuation')
    expect(connector?.data.variable).toEqual({ name: 'c1' })
    expect(continuation?.data.variable).toEqual({ name: 'c1' })
  })

  it('un-placeholders "No comment provided" back to an empty string', () => {
    const { body } = parseFbdXml('p', {
      comment: [
        {
          '@localId': '7',
          '@width': '100',
          '@height': '40',
          position: { '@x': '0', '@y': '0' },
          content: { 'xhtml:p': 'No comment provided' },
        },
      ],
    })
    expect(body.rung.nodes[0].data.content).toBe('')
  })

  it('keeps real comment text', () => {
    const { body } = parseFbdXml('p', {
      comment: [
        {
          '@localId': '8',
          '@width': '100',
          '@height': '40',
          position: { '@x': '0', '@y': '0' },
          content: { 'xhtml:p': 'Real comment' },
        },
      ],
    })
    expect(body.rung.nodes[0].data.content).toBe('Real comment')
  })

  it('warns (non-fatally) about inOutVariable nodes', () => {
    const { warnings } = parseFbdXml('p', { inOutVariable: [{}] })
    expect(warnings).toEqual(['POU "p": 1 FBD inOutVariable node(s) are not supported, skipped'])
  })

  it('warns (non-fatally) about a dangling connection reference', () => {
    const { body, warnings } = parseFbdXml('p', {
      outVariable: [
        {
          '@localId': '9',
          '@executionOrderId': '0',
          '@width': '80',
          '@height': '30',
          '@negated': 'false',
          position: { '@x': '0', '@y': '0' },
          connectionPointIn: {
            relPosition: { '@x': '0', '@y': '15' },
            connection: [{ '@refLocalId': 'doesnotexist' }],
          },
          expression: 'Y1',
        },
      ],
    })
    expect(body.rung.edges).toEqual([])
    expect(warnings).toEqual(['POU "p": FBD connection references unknown localId "doesnotexist", skipped'])
  })
})

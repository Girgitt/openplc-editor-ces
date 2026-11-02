/**
 * Pin-type inference — port of python's ComputeConnectionTypes +
 * ComputeBlockInputTypes (PLCGenerator.py:971-1241).
 *
 * Two passes over the flattened body graph. Pass 1 seeds concrete
 * types from declared variables, literals, contacts/coils/rails and
 * resolvable blocks; blocks with no known signature are deferred.
 * Pass 2 gives each deferred block a permissive all-ANY synthesized
 * signature and unifies each ANY-class pin group with any concrete
 * connected type. Pins known to share a type but still untyped live
 * in `related` groups that collapse when one member gets typed.
 */

import type { BlockInfos } from '../helpers/block-library'
import {
  asBlockData,
  asConnectorData,
  asContinuationData,
  asVariableData,
  asVariableExpressionData,
  type BlockData,
} from './narrow'
import type { RFBody, RFEdge, RFNode } from './types'

export interface TypeContext {
  /** Declared/dot-path/literal type of an expression, or null. */
  variableType(expression: string): string | null
  /** Block signature by type name (single generic signature), or null. */
  resolveBlock(typeName: string): BlockInfos | null
}

export function pinIn(nodeId: string, handle = ''): string {
  return `in:${nodeId}:${handle}`
}

export function pinOut(nodeId: string, handle = ''): string {
  return `out:${nodeId}:${handle}`
}

/**
 * Standard IEC functions whose import signatures can be reconstructed from
 * their formal pins, without guessing a project-specific FB interface.
 * This is a typed contract for *families* of IEC operators, not a permissive
 * all-ANY fallback. Other functions still require a library signature.
 */
type StandardIecFamily = 'comparison' | 'selection' | 'bitwise'
const STANDARD_IEC_FAMILIES: Readonly<Record<string, StandardIecFamily>> = {
  EQ: 'comparison', NE: 'comparison', GT: 'comparison', GE: 'comparison',
  LT: 'comparison', LE: 'comparison', SEL: 'selection',
  NOT: 'bitwise', AND: 'bitwise', OR: 'bitwise', XOR: 'bitwise',
}
const IEC_BIT_TYPES = new Set(['BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD'])
const isConcrete = (type: string | undefined): type is string =>
  type !== undefined && !type.toUpperCase().startsWith('ANY')
const normalizeType = (type: string): string => type.toUpperCase()


const LITERAL_TYPES: Record<string, string | null> = {
  T: 'TIME',
  D: 'DATE',
  TOD: 'TIME_OF_DAY',
  DT: 'DATE_AND_TIME',
  '2': null,
  '8': null,
  '16': null,
}

/** Literal-prefix typing from ComputeConnectionTypes (PLCGenerator.py:1001-1010). */
export function literalType(expression: string): string | null {
  const parts = expression.split('#')
  if (parts.length > 1) {
    const prefix = parts[0].toUpperCase()
    return prefix in LITERAL_TYPES ? LITERAL_TYPES[prefix] : prefix
  }
  if (expression.startsWith("'")) return 'STRING'
  if (expression.startsWith('"')) return 'WSTRING'
  return null
}

interface Graph {
  byId: Map<string, RFNode>
  incoming: Map<string, RFEdge[]>
}

class PinTypes {
  types = new Map<string, string>()
  related: string[][] = []

  extractRelated(pin: string): string[] {
    for (let i = 0; i < this.related.length; i++) {
      if (this.related[i].includes(pin)) return this.related.splice(i, 1)[0]
    }
    return [pin]
  }

  assign(pins: readonly string[], type: string): void {
    for (const pin of pins) this.types.set(pin, type)
  }
}

/** Restore a standard IEC signature only when the imported formal pin shape is exact. */
function standardIecSignature(data: BlockData): BlockInfos | null {
  if (data.blockKind === 'function-block-instance') return null
  const name = data.typeName.toUpperCase()
  const family = STANDARD_IEC_FAMILIES[name]
  if (!family) return null

  const actualInputs = data.inputs.filter((pin) => pin.toUpperCase() !== 'EN')
  const actualOutputs = data.outputs.filter((pin) => pin.toUpperCase() !== 'ENO')
  const inputs = family === 'comparison' ? ['IN1', 'IN2'] :
    family === 'selection' ? ['G', 'IN0', 'IN1'] :
    name === 'NOT' ? ['IN'] : actualInputs.map((pin) => pin.toUpperCase())
  // AND/OR/XOR are extensible bit-string operators; an imported instance
  // may expose IN1..INn, but never arbitrary or noncontiguous formals.
  if (family === 'bitwise' && name !== 'NOT' &&
      (inputs.length < 2 || inputs.length > 32 ||
       inputs.some((pin, index) => pin !== `IN${index + 1}`))) return null
  if (actualInputs.length !== inputs.length ||
      actualInputs.some((pin, index) => pin.toUpperCase() !== inputs[index])) return null
  if (actualOutputs.length !== 1 || actualOutputs[0].toUpperCase() !== 'OUT') return null

  const io = (pin: string, type: string) => ({ name: pin, type, qualifier: 'none' as const })
  return {
    name: data.typeName, type: 'function', extensible: name !== 'NOT' && family === 'bitwise',
    inputs: inputs.map((pin) => io(pin,
      family === 'comparison' ? 'ANY_ELEMENTARY' :
      family === 'selection' ? (pin === 'G' ? 'BOOL' : 'ANY') : 'ANY_BIT')),
    outputs: [io('OUT', family === 'comparison' ? 'BOOL' :
      family === 'bitwise' ? 'ANY_BIT' : 'ANY')],
    comment: '', usage: '',
  }
}

/**
 * Imported variants may be absent, name-only, or generic. Never overwrite
 * explicit incompatible concrete types with an inferred standard signature.
 */
function validateStandardVariant(node: RFNode, data: BlockData, provided: BlockInfos | null, standard: BlockInfos): void {
  if (provided === null) return
  const name = data.typeName.toUpperCase()
  const family = STANDARD_IEC_FAMILIES[name]
  const get = (pins: BlockInfos['inputs'], name: string) => pins.find((pin) => pin.name === name)?.type.toUpperCase()
  const output = get(provided.outputs, 'OUT')
  if (family === 'comparison' && isConcrete(output) && output !== 'BOOL') {
    throw new Error(`Invalid IEC signature for ${name} (block ${node.id}): OUT must be BOOL, got ${output}`)
  }
  if (family === 'selection') {
    const guard = get(provided.inputs, 'G')
    if (isConcrete(guard) && guard !== 'BOOL') {
      throw new Error(`Invalid IEC signature for SEL (block ${node.id}): G must be BOOL, got ${guard}`)
    }
  }
  if (family === 'bitwise') {
    const types: string[] = []
    for (const pin of standard.inputs) {
      const type = get(provided.inputs, pin.name)
      if (isConcrete(type)) types.push(type)
    }
    if (isConcrete(output)) types.push(output)
    for (const type of types) {
      if (!IEC_BIT_TYPES.has(type)) {
        throw new Error(`Invalid IEC signature for ${name} (block ${node.id}): expected ANY_BIT, got ${type}`)
      }
    }
    if (new Set(types).size > 1) {
      throw new Error(`Invalid IEC signature for ${name} (block ${node.id}): bit-string pin types disagree`)
    }
  }
}


export function computeConnectionTypes(body: RFBody, ctx: TypeContext): Map<string, string> {
  const graph: Graph = { byId: new Map(), incoming: new Map() }
  const nodes: RFNode[] = []
  for (const rung of body.rungs) {
    for (const node of rung.nodes) {
      graph.byId.set(node.id, node)
      graph.incoming.set(node.id, [])
      nodes.push(node)
    }
    for (const edge of rung.edges) {
      graph.incoming.get(edge.target)?.push(edge)
    }
  }

  const pt = new PinTypes()
  const deferred: { node: RFNode; data: BlockData }[] = []

  for (const node of nodes) {
    switch (node.type) {
      case 'variable':
      case 'input-variable':
      case 'output-variable':
      case 'inout-variable': {
        const data = asVariableData(node.data)
        if (data === null) break
        const expr = asVariableExpressionData(node.data)?.expression ?? data.variable
        const varType = ctx.variableType(expr) ?? literalType(expr)
        if (varType === null) break
        if (data.variant === 'input' || data.variant === 'inout') {
          pt.assign(pt.extractRelated(pinOut(node.id)), varType)
        }
        if (data.variant === 'output' || data.variant === 'inout') {
          pt.types.set(pinIn(node.id), varType)
          const source = sourcePin(graph, node.id)
          if (source !== null && !pt.types.has(source)) {
            pt.assign(pt.extractRelated(source), varType)
          }
        }
        break
      }
      case 'contact':
      case 'coil':
      case 'parallel':
      case 'powerRail': {
        pt.assign(pt.extractRelated(pinOut(node.id)), 'BOOL')
        pt.types.set(pinIn(node.id), 'BOOL')
        for (const edge of graph.incoming.get(node.id) ?? []) {
          const source = edgeSourcePin(graph, edge)
          if (!pt.types.has(source)) pt.assign(pt.extractRelated(source), 'BOOL')
        }
        break
      }
      case 'continuation': {
        const name = asContinuationData(node.data)?.name
        if (name === undefined) break
        let connector: RFNode | null = null
        for (const candidate of nodes) {
          if (candidate.type === 'connector' && asConnectorData(candidate.data)?.name === name) {
            connector = candidate
            break
          }
        }
        if (connector === null) break
        const undefinedPins = [pinOut(node.id), pinIn(connector.id)]
        const source = sourcePin(graph, connector.id)
        if (source !== null) undefinedPins.push(source)
        let varType = 'ANY'
        const related: string[] = []
        for (const pin of undefinedPins) {
          const known = pt.types.get(pin)
          if (known !== undefined) varType = known
          else related.push(...pt.extractRelated(pin))
        }
        if (varType.startsWith('ANY') && related.length > 0) pt.related.push(related)
        else pt.assign(related, varType)
        break
      }
      case 'block': {
        const data = asBlockData(node.data)
        if (data === null) break
        const provided = ctx.resolveBlock(data.typeName)
        const wired = wiredInputHandles(graph, node, data).filter((name) => name !== 'EN')
        const outputs = outputHandles(data).filter((name) => name !== 'ENO')
        const providedComplete =
          provided !== null &&
          wired.every((name) => provided.inputs.some((formal) => formal.name === name)) &&
          outputs.every((name) => provided.outputs.some((formal) => formal.name === name))
        const standard = standardIecSignature(data)
        const family = STANDARD_IEC_FAMILIES[data.typeName.toUpperCase()]
        // A known IEC function with a malformed pin shape must not fall back
        // to homogeneous, permissive inference (especially for bitwise ops).
        if (family && data.blockKind !== 'function-block-instance' && standard === null) {
          throw new Error(`Missing typed IEC signature for ${data.typeName} (block ${node.id}): invalid standard IEC pin shape`)
        }
        if (standard !== null) validateStandardVariant(node, data, provided, standard)
        // For standardized operators, a generic or incomplete persisted
        // signature cannot be trusted: use the shared IEC family contract.
        const providedGeneric = standard !== null && provided !== null &&
          [...provided.inputs, ...provided.outputs].some((formal) => formal.type.toUpperCase().startsWith('ANY'))
        const infos = standard !== null && (!providedComplete || providedGeneric)
          ? standard : provided
        const complete =
          infos !== null &&
          wired.every((name) => infos.inputs.some((formal) => formal.name === name)) &&
          outputs.every((name) => infos.outputs.some((formal) => formal.name === name))
        const homogeneous = new Set(['ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'MIN', 'MAX', 'LIMIT', 'ABS', 'MOVE', 'NEG'])
        const safeGeneric = homogeneous.has(data.typeName.toUpperCase())
        // Unrecognized mixed-type functions must retain a complete, typed
        // signature. Recognized IEC comparisons have a fixed BOOL result;
        // SEL may have generic ANY output only when its pin shape is exact.
        if (
          !safeGeneric && data.blockKind !== 'function-block-instance' &&
          (infos === null || !complete || (standard === null && outputs.some((name) => {
            const formal = infos.outputs.find((item) => item.name === name)
            return formal === undefined || formal.type.startsWith('ANY')
          })))
        ) {
          throw new Error(
            `Missing typed IEC signature for ${data.typeName} (block ${node.id}); ` +
              'restore the block library signature before compiling',
          )
        }
        if (complete && infos !== null) {
          computeBlockInputTypes(graph, pt, node, data, infos)
        } else if (data.blockKind === 'function-block-instance') {
          // FB interfaces can mix unrelated types (PID has BOOL, REAL and
          // TIME pins). An all-ANY fallback would wrongly infer the output
          // as e.g. TIME from CYCLE. Its actual member type must come from
          // a restored, typed library/POU signature.
          continue
        } else {
          // Without a complete library signature, all-ANY inference is sound
          // only for known homogeneous IEC operations. E.g. GT has a BOOL
          // result while its operands are numeric; silently making its OUT
          // REAL would produce plausible but incorrect source code.
          for (const handle of wiredInputHandles(graph, node, data)) {
            const pin = pinIn(node.id, handle)
            const source = sourcePin(graph, node.id, handle)
            if (source === null) continue
            const sourceType = pt.types.get(source)
            if (sourceType !== undefined) {
              pt.types.set(pin, sourceType)
            } else {
              const related = pt.extractRelated(source)
              related.push(pin)
              pt.related.push(related)
            }
          }
          deferred.push({ node, data })
        }
        break
      }
    }
  }

  // Validate the actual wired types, not only the possibly partial library
  // variant. For bitwise ops every IN and OUT shares one concrete ANY_BIT
  // type. SEL has a BOOL guard and one shared data type; comparisons have a
  // BOOL result and compatible input operands.
  const validateStandardWires = (): void => {
    for (const node of nodes) {
      if (node.type !== 'block') continue
      const data = asBlockData(node.data)
      if (data === null) continue
      const standard = standardIecSignature(data)
      if (standard === null) continue
      const name = data.typeName.toUpperCase()
      const family = STANDARD_IEC_FAMILIES[name]
      const getType = (name: string): string | undefined => {
        const source = sourcePin(graph, node.id, name)
        return source === null ? pt.types.get(pinIn(node.id, name)) : pt.types.get(source)
      }
      if (family === 'selection') {
        const guard = getType('G')
        if (isConcrete(guard) && guard.toUpperCase() !== 'BOOL') {
          throw new Error(`Invalid IEC guard for SEL (block ${node.id}): G must be BOOL, got ${guard}`)
        }
      }
      const pins = standard.inputs.filter((pin) => pin.name !== 'G').map((pin) => pin.name)
      const types = new Set<string>()
      for (const pin of pins) {
        const type = getType(pin)
        if (isConcrete(type)) types.add(normalizeType(type))
      }
      const outType = pt.types.get(pinOut(node.id, 'OUT'))
      if (family !== 'comparison' && isConcrete(outType)) types.add(normalizeType(outType))

      // A completely typed imported/library variant is authoritative, but
      // computeBlockInputTypes does not overwrite pre-existing wire types.
      // Therefore compare *each* concrete formal with the final connected
      // type; checking only the resulting homogeneous wire group would let
      // a stale BOOL signature silently compile against a WORD/REAL wire.
      const provided = ctx.resolveBlock(data.typeName)
      if (provided !== null) {
        for (const formal of [...provided.inputs, ...provided.outputs]) {
          if (!isConcrete(formal.type)) continue
          const pinType = provided.inputs.includes(formal)
            ? getType(formal.name)
            : pt.types.get(pinOut(node.id, formal.name))
          if (isConcrete(pinType) && normalizeType(pinType) !== normalizeType(formal.type)) {
            throw new Error(
              `IEC signature/wire type mismatch for ${name} (block ${node.id}), ` +
              `${formal.name}: declared ${formal.type}, connected ${pinType}`,
            )
          }
        }
      }
      if (family === 'bitwise') {
        for (const type of types) {
          if (!IEC_BIT_TYPES.has(type)) {
            throw new Error(`Invalid IEC operand type for ${name} (block ${node.id}): expected ANY_BIT, got ${type}`)
          }
        }
      }
      if (types.size > 1) {
        throw new Error(`Conflicting IEC operand types for ${name} (block ${node.id}): ${[...types].join(', ')}; insert an explicit conversion before compiling`)
      }
      if (family === 'comparison' && isConcrete(outType) && normalizeType(outType) !== 'BOOL') {
        throw new Error(`Invalid IEC result type for ${name} (block ${node.id}): OUT must be BOOL, got ${outType}`)
      }
    }
  }
  validateStandardWires()

  for (const { node, data } of deferred) {
    // Detect conflicting concrete types rather than depending on whichever
    // input happened to be visited last. Numeric conversions must be explicit.
    const concrete = new Set<string>()
    for (const handle of wiredInputHandles(graph, node, data)) {
      const source = sourcePin(graph, node.id, handle)
      const candidate = source !== null ? pt.types.get(source) : undefined
      if (candidate !== undefined && !candidate.startsWith('ANY')) concrete.add(candidate)
    }
    const outputType = outputHandles(data)
      .map((out) => pt.types.get(pinOut(node.id, out)))
      .filter((candidate): candidate is string => candidate !== undefined && !candidate.startsWith('ANY'))
    for (const candidate of outputType) concrete.add(candidate)
    if (concrete.size > 1) {
      throw new Error(
        `Conflicting IEC types for ${data.typeName} (block ${node.id}): ${[...concrete].join(', ')}; ` +
          'insert an explicit conversion before compiling',
      )
    }
    const infos = synthesizePermissiveBlockInfos(graph, node, data)
    computeBlockInputTypes(graph, pt, node, data, infos)
  }

  validateStandardWires()
  return pt.types
}

/** ComputeBlockInputTypes (PLCGenerator.py:1183-1241). */
function computeBlockInputTypes(graph: Graph, pt: PinTypes, node: RFNode, data: BlockData, infos: BlockInfos): void {
  const undefinedGroups = new Map<string, string[]>()
  const bucket = (anyClass: string, pin: string) => {
    const group = undefinedGroups.get(anyClass) ?? []
    group.push(pin)
    undefinedGroups.set(anyClass, group)
  }

  for (const out of outputHandles(data)) {
    const pin = pinOut(node.id, out)
    if (out === 'ENO') {
      pt.assign(pt.extractRelated(pin), 'BOOL')
      continue
    }
    for (const formal of infos.outputs) {
      if (formal.name !== out) continue
      if (formal.type.startsWith('ANY')) bucket(formal.type, pin)
      else if (!pt.types.has(pin)) pt.assign(pt.extractRelated(pin), formal.type)
    }
  }

  for (const handle of wiredInputHandles(graph, node, data)) {
    const pin = pinIn(node.id, handle)
    if (handle === 'EN') {
      pt.assign(pt.extractRelated(pin), 'BOOL')
      continue
    }
    for (const formal of infos.inputs) {
      if (formal.name !== handle) continue
      const source = sourcePin(graph, node.id, handle)
      if (formal.type.startsWith('ANY')) {
        bucket(formal.type, pin)
        if (source !== null) bucket(formal.type, source)
      } else {
        pt.types.set(pin, formal.type)
        if (source !== null && !pt.types.has(source)) {
          pt.assign(pt.extractRelated(source), formal.type)
        }
      }
    }
  }

  for (const [anyClass, pins] of undefinedGroups) {
    let varType = anyClass
    const related: string[] = []
    for (const pin of pins) {
      const known = pt.types.get(pin)
      if (known !== undefined && !known.startsWith('ANY')) varType = known
      else related.push(...pt.extractRelated(pin))
    }
    if (varType.startsWith('ANY') && related.length > 0) pt.related.push(related)
    else pt.assign(related, varType)
  }
}

/** SynthesizePermissiveBlockInfos (PLCGenerator.py:732-763). */
function synthesizePermissiveBlockInfos(graph: Graph, node: RFNode, data: BlockData): BlockInfos {
  return {
    name: data.typeName,
    type: data.blockKind === 'function-block-instance' ? 'functionBlock' : 'function',
    extensible: false,
    inputs: wiredInputHandles(graph, node, data)
      .filter((h) => h !== 'EN')
      .map((h) => ({ name: h, type: 'ANY', qualifier: 'none' as const })),
    outputs: outputHandles(data)
      .filter((h) => h !== 'ENO')
      .map((h) => ({ name: h, type: 'ANY', qualifier: 'none' as const })),
    comment: '',
    usage: '',
  }
}

// python only ever sees serialized (wired) input pins; EN first when wired
function wiredInputHandles(graph: Graph, node: RFNode, data: BlockData): string[] {
  const wired = new Set((graph.incoming.get(node.id) ?? []).map((e) => e.targetHandle ?? ''))
  const handles: string[] = []
  if (wired.has('EN')) handles.push('EN')
  for (const name of data.inputs) {
    if (name === 'EN') continue
    if (wired.has(name)) handles.push(name)
  }
  return handles
}

function outputHandles(data: BlockData): string[] {
  const handles = [...data.outputs]
  if (data.executionControl && !handles.includes('ENO')) handles.push('ENO')
  return handles
}

function sourcePin(graph: Graph, nodeId: string, handle?: string): string | null {
  for (const edge of graph.incoming.get(nodeId) ?? []) {
    if (handle === undefined || (edge.targetHandle ?? '') === handle) {
      return edgeSourcePin(graph, edge)
    }
  }
  return null
}

function edgeSourcePin(graph: Graph, edge: RFEdge): string {
  const source = graph.byId.get(edge.source)
  if (source !== undefined && source.type === 'block') {
    return pinOut(edge.source, edge.sourceHandle ?? '')
  }
  return pinOut(edge.source)
}

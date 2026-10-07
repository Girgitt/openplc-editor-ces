/**
 * FBD wires are semantic references, not merely lines between coordinates.
 * PLCopen generation must never silently drop a visible ReactFlow edge.
 * Resolve imported/legacy handle identifiers only when the pin is unambiguous.
 */
import type { FBDRungState } from '@root/middleware/shared/ports/types'
import type { Edge, Node } from '@xyflow/react'

// A utility-layer structural projection of the fields required for semantic
// connection validation. Do not depend on renderer or store node types here.
type FbdConnectionData = {
  numericId?: string
  inputHandles?: ReadonlyArray<{ id?: string | null }>
  outputHandles?: ReadonlyArray<{ id?: string | null }>
}

function resolveHandle(
  node: Node,
  handleId: string | null | undefined,
  direction: 'source' | 'target',
  edgeId: string,
): string {
  const data = node.data as FbdConnectionData
  const handles = direction === 'source' ? data.outputHandles : data.inputHandles
  const ids = (handles ?? [])
    .map((handle) => handle.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  const requested = (handleId ?? '').trim()
  const exact = ids.find((id) => id === requested)
  if (exact !== undefined) return exact

  // IEC formal parameters are case-insensitive. Never guess between pins whose
  // names differ only by case: the source graph is ambiguous in that case.
  const insensitive = ids.filter((id) => id.toUpperCase() === requested.toUpperCase())
  if (requested && insensitive.length === 1) return insensitive[0]

  // Older PLCopen transports omit formalParameter for leaf connections, and
  // older ReactFlow versions used 'out'/'in' rather than the leaf sentinel.
  // Accept those aliases only for a node with exactly one pin in this direction.
  const aliases = direction === 'source' ? ['out', 'output', 'output-variable'] : ['in', 'input', 'input-variable']
  if (ids.length === 1 && (!requested || aliases.includes(requested.toLowerCase()))) return ids[0]

  throw new Error(
    `FBD edge "${edgeId}" references ${direction} pin "${handleId ?? ''}" on node "${node.id}"` +
      `; available ${direction} pins: ${ids.length ? ids.join(', ') : '(none)'}. Reconnect the wire.`,
  )
}

export function normalizeFbdEdges(nodes: Node[], edges: Edge[]): Edge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const byLocalId = new Map<string, string>()
  for (const node of nodes) {
    const numericId = (node.data as FbdConnectionData).numericId
    if (!numericId) continue
    const previous = byLocalId.get(numericId)
    if (previous && previous !== node.id) {
      throw new Error(
        `FBD nodes "${previous}" and "${node.id}" share PLCopen localId "${numericId}"; connections are ambiguous.`,
      )
    }
    byLocalId.set(numericId, node.id)
  }
  return edges.map((edge) => {
    const source = byId.get(edge.source)
    const target = byId.get(edge.target)
    if (!source || !target) {
      throw new Error(
        `FBD edge "${edge.id}" references missing node(s): source "${edge.source}", target "${edge.target}".`,
      )
    }
    const sourceHandle = resolveHandle(source, edge.sourceHandle, 'source', edge.id)
    const targetHandle = resolveHandle(target, edge.targetHandle, 'target', edge.id)
    return sourceHandle === edge.sourceHandle && targetHandle === edge.targetHandle
      ? edge
      : { ...edge, sourceHandle, targetHandle }
  })
}

export function validateFbdRung(rung: FBDRungState): FBDRungState {
  return { ...rung, edges: normalizeFbdEdges(rung.nodes, rung.edges) }
}

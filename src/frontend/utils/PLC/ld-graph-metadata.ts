/**
 * OpenPLC Editor LD round-trip extension for PLCopen TC6 2.01.
 *
 * PLCopen stores executable connections but not our ReactFlow parallel-open / close
 * junctions, rung boundaries, branch handles, or editor coordinates. Keep that
 * information under <body><addData> (the standard extension point), WITHOUT
 * altering <LD>. The signature prevents restoring stale layout when a foreign
 * tool has modified the executable network after the extension was written.
 */
import type { RungLadderState } from '../../../middleware/shared/ports/types'

const DATA_URI = 'urn:openplc-editor:ld-graph:v1'
const ELEMENT = 'openplc:ldGraph'
const MAX_GRAPH_LENGTH = 3_000_000

const asObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const asArray = (value: unknown): unknown[] => value === undefined || value === '' ? [] : Array.isArray(value) ? value : [value]
const str = (value: unknown): string => value === undefined || value === null ? '' : String(value)

/** Canonicalize the *executable* LD XML, ignoring geometry and XML node ordering. */
export function ldExecutableSignature(ldXml: unknown): string {
  const ld = asObject(ldXml)
  const types = ['leftPowerRail', 'rightPowerRail', 'contact', 'coil', 'block', 'inVariable', 'inOutVariable', 'outVariable']
  const signatures: string[] = []
  const connections = (point: unknown): string[] => asArray(asObject(point).connection)
    .map((entry) => {
      const obj = asObject(entry)
      return `${str(obj['@refLocalId'])}:${str(obj['@formalParameter'])}`
    }).sort()
  for (const type of types) {
    for (const raw of asArray(ld[type])) {
      const node = asObject(raw)
      const item = {
        type,
        id: str(node['@localId']),
        name: str(node['@instanceName']),
        dataType: str(node['@typeName']),
        symbol: str(Array.isArray(node.variable) ? node.variable[0] : node.variable ?? node.expression),
        negated: str(node['@negated']),
        edge: str(node['@edge']),
        storage: str(node['@storage']),
        incoming: connections(asObject(node.connectionPointIn)),
        inputs: asArray(asObject(node.inputVariables).variable).map((rawPin) => {
          const pin = asObject(rawPin)
          return [str(pin['@formalParameter']), ...connections(asObject(pin.connectionPointIn))].join('|')
        }).sort(),
      }
      signatures.push(JSON.stringify(item))
    }
  }
  return JSON.stringify(signatures.sort())
}

export function encodeLdGraph(rungs: RungLadderState[], ldXml: unknown) {
  // selectedNodes is an editor selection cache. Never persist it as an extra
  // graph copy; the authoritative nodes and edges are stored once per rung.
  const snapshot = rungs.map(({ selectedNodes: _selection, ...rung }) => rung)
  const payload = JSON.stringify({ version: 1, executable: ldExecutableSignature(ldXml), rungs: snapshot })
  return {
    data: {
      '@name': DATA_URI,
      '@handleUnknown': 'preserve',
      [ELEMENT]: { '@xmlns:openplc': 'urn:openplc-editor:ld-graph', $: payload },
    },
  }
}

export function decodeLdGraph(
  addData: unknown,
  ldXml: unknown,
): { rungs?: RungLadderState[]; warning?: string } {
  const entry = asArray(asObject(addData).data).map(asObject).find((data) => str(data['@name']) === DATA_URI)
  if (!entry) return {}
  const rawElement = entry[ELEMENT]
  const text = typeof rawElement === 'string' ? rawElement : asObject(rawElement).$
  if (typeof text !== 'string' || text.length > MAX_GRAPH_LENGTH) {
    return { warning: 'LD editor layout metadata is malformed or too large; using PLCopen connections instead' }
  }
  try {
    const payload: unknown = JSON.parse(text)
    const graph = asObject(payload)
    if (graph.version !== 1 || graph.executable !== ldExecutableSignature(ldXml) || !Array.isArray(graph.rungs)) {
      return { warning: 'LD editor layout does not match executable PLCopen connections; ignoring stale layout' }
    }
    const rungs = graph.rungs as RungLadderState[]
    const ids = new Set<string>()
    for (const rung of rungs) {
      if (!rung || typeof rung.id !== 'string' || !Array.isArray(rung.nodes) || !Array.isArray(rung.edges) ||
          !Array.isArray(rung.defaultBounds) || !Array.isArray(rung.reactFlowViewport)) {
        return { warning: 'LD editor layout contains invalid rung data; using PLCopen connections instead' }
      }
      const localIds = new Set<string>()
      for (const node of rung.nodes) {
        if (!node || typeof node.id !== 'string' || typeof node.type !== 'string' ||
            !node.position || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y) ||
            typeof node.data?.numericId !== 'string' || ids.has(node.id) || localIds.has(node.id)) {
          return { warning: 'LD editor layout contains invalid nodes; using PLCopen connections instead' }
        }
        localIds.add(node.id)
        ids.add(node.id)
      }
      if (rung.edges.some((edge) => !edge || !localIds.has(edge.source) || !localIds.has(edge.target))) {
        return { warning: 'LD editor layout contains dangling connections; using PLCopen connections instead' }
      }
    }
    return { rungs: rungs.map((rung) => ({ ...rung, selectedNodes: [] })) }
  } catch {
    return { warning: 'LD editor layout metadata cannot be decoded; using PLCopen connections instead' }
  }
}

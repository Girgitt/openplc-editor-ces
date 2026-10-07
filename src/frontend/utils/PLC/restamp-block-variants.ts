import type { BlockVariant } from '@root/middleware/shared/ports/block-types'
import type { SystemLibrary } from '@root/middleware/shared/ports/library-types'
import type { PLCPou } from '@root/middleware/shared/ports/types'

/**
 * Refresh the *types* carried by placed graphical block variants from whatever
 * currently defines the block.
 *
 * A block's signature is copied into `node.data.variant` once, when the block
 * is dropped on the canvas (see the FBD/LD `handleAddElementByDropping`), and
 * then frozen in the saved project. When the definition later changes its pin
 * or return type, already-placed blocks keep the stale one: the transpiler
 * (which reads `node.data.variant` via `collect-library-blocks`) emits the old
 * type, and the relink pass compares a refreshed variable against the stale pin
 * and breaks a link that is semantically fine (DOPE-548).
 *
 * Two definitions feed a placed block, and both are re-stamped on project load:
 * the bundled system libraries, and the project's own functions and function
 * blocks. A user POU takes precedence over a library entry of the same name,
 * since the project owns its own interface.
 *
 * Ladder pin nodes cache their pin's type a second time, in
 * `data.block.variableType`, and that copy is the one the relink pass actually
 * reads. It is otherwise refreshed only by a layout pass that does not run on
 * load, so it is re-stamped here too.
 *
 * The refresh remains type-only for ordinary saved projects. PLCopen-imported
 * blocks are the one exception: their variant arrives without a typed signature,
 * so when that signature is hydrated from the authoritative definition we also
 * reconcile the FBD handle set. This repairs transport-loss artifacts without
 * silently applying interface changes to normal project-owned blocks; those
 * still use the divergence/update workflow.
 */

type VariantVariable = BlockVariant['variables'][number]
type VariantVariableType = VariantVariable['type']

/** Pin types of one definition, keyed by variable name. IEC names are case-insensitive. */
type PinTypes = Map<string, VariantVariableType>

/** Index every library POU by name, for O(1) lookup. IEC names are case-insensitive. */
function indexLibraryPous(systemLibraries: SystemLibrary[]): Map<string, SystemLibrary['pous'][number]> {
  const byName = new Map<string, SystemLibrary['pous'][number]>()
  for (const library of systemLibraries) {
    for (const pou of library.pous) {
      // First definition wins; bundled libraries don't collide on name.
      const key = pou.name.toUpperCase()
      if (!byName.has(key)) byName.set(key, pou)
    }
  }
  return byName
}

/** Index the project's own functions and function blocks by name. */
function indexUserPous(userPous: PLCPou[]): Map<string, PLCPou> {
  const byName = new Map<string, PLCPou>()
  for (const pou of userPous) byName.set(pou.name.toUpperCase(), pou)
  return byName
}

function libraryPinTypes(pou: SystemLibrary['pous'][number]): PinTypes {
  const types: PinTypes = new Map()
  for (const variable of pou.variables) types.set(variable.name.toUpperCase(), variable.type as VariantVariableType)
  return types
}

function userPouPinTypes(pou: PLCPou): PinTypes {
  const types: PinTypes = new Map()
  for (const variable of pou.interface?.variables ?? []) {
    // Placed variants upper-case their values (see the drop path), and a user
    // pin may be a data type or an array, which the variant schema's union
    // does not name — the placed shape has always carried them.
    types.set(variable.name.toUpperCase(), {
      definition: variable.type.definition,
      value: variable.type.value.toUpperCase(),
    } as VariantVariableType)
  }
  const returnType = pou.interface?.returnType
  // A function's return pin is synthesised as OUT when the block is dropped.
  if (pou.pouType === 'function' && returnType) {
    types.set('OUT', { definition: 'base-type', value: returnType.toUpperCase() } as VariantVariableType)
  }
  return types
}

/** A minimal block-bearing node shape; both FBD and LD nodes satisfy it. */
type RestampedHandle = {
  id?: string
  type: string
  position?: string
  glbPosition: { x: number; y: number }
  relPosition: { x: number; y: number }
  style?: Record<string, unknown>
  [key: string]: unknown
}

type RestampedEdge = {
  source?: string
  sourceHandle?: string | null
  target?: string
  targetHandle?: string | null
  [key: string]: unknown
}

/** A minimal block-bearing node shape; both FBD and LD nodes satisfy it. */
type BlockBearingNode = {
  id?: string
  type?: string
  position?: { x: number; y: number }
  width?: number
  height?: number
  measured?: { width?: number; height?: number }
  data?: {
    variant?: BlockVariant
    executionControl?: boolean
    handles?: RestampedHandle[]
    inputHandles?: RestampedHandle[]
    outputHandles?: RestampedHandle[]
    inputConnector?: RestampedHandle
    outputConnector?: RestampedHandle
  }
}

/** A ladder pin node: it caches the type of the block pin it connects to. */
type PinBearingNode = {
  type?: string
  data?: {
    block?: { id?: string; handleId?: string; variableType?: VariantVariable }
  }
}

const FBD_FIRST_PIN_Y = 48
const FBD_PIN_STEP_Y = 48
const FBD_PIN_FOOTER_Y = 24

function expectedInputVariables(variant: BlockVariant, executionControl = false): VariantVariable[] {
  return variant.variables.filter(
    (variable) =>
      (variable.class === 'input' || variable.class === 'inOut') &&
      (variable.name !== 'EN' || executionControl),
  )
}

function expectedOutputVariables(variant: BlockVariant, executionControl = false): VariantVariable[] {
  return variant.variables.filter(
    (variable) => variable.class === 'output' && (variable.name !== 'ENO' || executionControl),
  )
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function sameHandleGeometry(a: RestampedHandle, b: RestampedHandle): boolean {
  return (
    a.id === b.id &&
    a.type === b.type &&
    a.position === b.position &&
    a.relPosition.x === b.relPosition.x &&
    a.relPosition.y === b.relPosition.y &&
    a.glbPosition.x === b.glbPosition.x &&
    a.glbPosition.y === b.glbPosition.y &&
    a.style?.top === b.style?.top &&
    a.style?.left === b.style?.left &&
    a.style?.right === b.style?.right
  )
}

function normalizedImportedHandles(
  node: BlockBearingNode,
  variables: VariantVariable[],
  existingHandles: RestampedHandle[],
  side: 'input' | 'output',
): { handles: RestampedHandle[]; changed: number } {
  const existingByName = new Map(
    existingHandles.flatMap((handle) => (handle.id ? [[handle.id.toUpperCase(), handle] as const] : [])),
  )
  const usedY = new Set<number>()
  const position = node.position ?? { x: 0, y: 0 }
  let changed = 0

  const handles = variables.map((variable, index) => {
    const existing = existingByName.get(variable.name.toUpperCase())
    let relY = existing && finite(existing.relPosition?.y) ? existing.relPosition.y : NaN
    if (!finite(relY) || usedY.has(relY)) {
      relY = FBD_FIRST_PIN_Y + index * FBD_PIN_STEP_Y
      while (usedY.has(relY)) relY += FBD_PIN_STEP_Y
    }
    usedY.add(relY)

    const defaultX = side === 'input' ? 0 : (node.width ?? 0)
    const relX = existing && finite(existing.relPosition?.x) ? existing.relPosition.x : defaultX
    const normalized: RestampedHandle = {
      ...(existing ?? {}),
      id: variable.name,
      type: side === 'input' ? 'target' : 'source',
      position: side === 'input' ? 'left' : 'right',
      relPosition: { x: relX, y: relY },
      glbPosition: { x: position.x + relX, y: position.y + relY },
      style: {
        ...(existing?.style ?? {}),
        top: relY,
        ...(side === 'input' ? { left: 0 } : { right: 0 }),
      },
    }
    if (!existing || !sameHandleGeometry(existing, normalized)) changed += 1
    return normalized
  })

  if (existingHandles.length !== handles.length) changed += Math.abs(existingHandles.length - handles.length)
  else if (existingHandles.some((handle, index) => handle.id !== handles[index]?.id)) changed += 1

  return { handles, changed }
}

/**
 * PLCopen import constructs FBD handles from the pins present in the XML, while
 * the later library restamp restores the authoritative block signature. If a
 * previous transport lost a formal parameter (or collapsed two pins onto one
 * coordinate), the block therefore ends up in an impossible half-state: labels
 * come from the complete library signature while ReactFlow still carries a
 * reduced/stacked handle set.
 *
 * Reconcile this only for a PLCopen-imported block whose variant arrived empty
 * and was just hydrated from the current definition. Ordinary saved projects
 * retain the explicit divergence/update workflow for interface changes.
 */
function reconcileHydratedFbdHandles(node: BlockBearingNode, edges: RestampedEdge[]): number {
  const data = node.data
  const variant = data?.variant
  if (!data || !variant || !Array.isArray(data.inputHandles) || !Array.isArray(data.outputHandles)) return 0

  let changed = 0
  const inputVariables = expectedInputVariables(variant, data.executionControl === true)
  const outputVariables = expectedOutputVariables(variant, data.executionControl === true)
  const nextInputs = normalizedImportedHandles(node, inputVariables, data.inputHandles, 'input')
  const nextOutputs = normalizedImportedHandles(node, outputVariables, data.outputHandles, 'output')
  changed += nextInputs.changed + nextOutputs.changed

  const nextHandles = [...nextInputs.handles, ...nextOutputs.handles]
  const handlesChanged =
    !Array.isArray(data.handles) ||
    data.handles.length !== nextHandles.length ||
    data.handles.some((handle, index) => !nextHandles[index] || !sameHandleGeometry(handle, nextHandles[index]))

  if (nextInputs.changed > 0 || nextOutputs.changed > 0 || handlesChanged) {
    data.inputHandles = nextInputs.handles
    data.outputHandles = nextOutputs.handles
    data.handles = nextHandles
    data.inputConnector = nextInputs.handles[0]
    data.outputConnector = nextOutputs.handles[0]
    if (handlesChanged) changed += 1
  }

  // Match the minimum height used by the normal FBD block builder so a recovered
  // lower pin cannot sit outside a block whose earlier transport had collapsed
  // its signature.
  const sideCount = Math.max(inputVariables.length, outputVariables.length)
  if (sideCount > 0) {
    const minimumHeight = FBD_FIRST_PIN_Y + FBD_PIN_FOOTER_Y + Math.max(sideCount - 1, 0) * FBD_PIN_STEP_Y
    if (!finite(node.height) || node.height < minimumHeight) {
      node.height = minimumHeight
      if (node.measured) node.measured.height = minimumHeight
      changed += 1
    }
  }

  if (!node.id || inputVariables.length === 0) return changed

  // A normal FBD block input accepts one source. Older CES round trips could
  // collapse two distinct target pins onto the first imported handle. When the
  // hydrated definition exposes an unused declared pin, preserve the first wire
  // on its valid named pin and deterministically move duplicate/unknown incoming
  // wires onto the missing pins in declaration order.
  const expectedNames = inputVariables.map((variable) => variable.name)
  const expectedByUpper = new Map(expectedNames.map((name) => [name.toUpperCase(), name]))
  const occupied = new Set<string>()
  const repair: RestampedEdge[] = []
  for (const edge of edges) {
    if (edge.target !== node.id) continue
    const target = edge.targetHandle ? expectedByUpper.get(edge.targetHandle.toUpperCase()) : undefined
    if (target && !occupied.has(target.toUpperCase())) {
      occupied.add(target.toUpperCase())
      if (edge.targetHandle !== target) {
        edge.targetHandle = target
        changed += 1
      }
      continue
    }
    repair.push(edge)
  }

  const available = expectedNames.filter((name) => !occupied.has(name.toUpperCase()))
  for (const [index, edge] of repair.entries()) {
    const target = available[index]
    if (!target) break
    if (edge.targetHandle !== target) {
      edge.targetHandle = target
      changed += 1
    }
    occupied.add(target.toUpperCase())
  }

  return changed
}

function restampBlockNodes(
  nodes: BlockBearingNode[],
  edges: RestampedEdge[],
  libraryPousByName: Map<string, SystemLibrary['pous'][number]>,
  userPousByName: Map<string, PLCPou>,
  repairImportedFbdHandles: boolean,
): number {
  let changed = 0
  for (const node of nodes) {
    if (node?.type !== 'block') continue
    const variant = node.data?.variant
    const name = variant?.name
    // `node.data` is `z.any()` in the flow schema, so a hand-edited or
    // half-migrated project can reach here without a usable variant.
    if (!variant || !name || !Array.isArray(variant.variables)) continue

    // The project owns its own POUs, so they win over a library of the same name.
    const userPou = userPousByName.get(name.toUpperCase())
    const libPou = userPou ? undefined : libraryPousByName.get(name.toUpperCase())
    if (!userPou && !libPou) continue
    const pinTypes = userPou ? userPouPinTypes(userPou) : libraryPinTypes(libPou!)

    // PLCopen block instances carry their semantic pin names but not pin IEC
    // types.  The CES canonical round trip therefore reconstructs handles from
    // those names, while the authoritative type/class signature comes from the
    // current library (or project-owned POU). Hydrate an imported empty variant
    // before the normal type-refresh pass.
    const hydratedImportedSignature = variant.variables.length === 0
    if (hydratedImportedSignature) {
      if (libPou) {
        variant.variables = libPou.variables.map((variable) => ({
          ...variable,
          type: { ...variable.type },
        })) as typeof variant.variables
      } else if (userPou) {
        const restored = (userPou.interface?.variables ?? []).map((variable) => ({
          id: variable.id,
          name: variable.name,
          class: variable.class,
          type: { ...variable.type, value: variable.type.value.toUpperCase() },
        }))
        if (userPou.pouType === 'function' && userPou.interface?.returnType) {
          const returnType = userPou.interface.returnType.toUpperCase()
          restored.push({
            id: 'OUT',
            name: 'OUT',
            class: 'output',
            type: { definition: 'base-type', value: returnType },
          } as (typeof restored)[number])
        }
        variant.variables = restored as typeof variant.variables
      }
      changed += variant.variables.length
      if (repairImportedFbdHandles) changed += reconcileHydratedFbdHandles(node, edges)
    }

    for (const variable of variant.variables) {
      const next = pinTypes.get(variable.name.toUpperCase())
      // A pin the definition no longer declares (EN/ENO, a removed one) is left
      // alone: dropping it would orphan its handle and its wiring.
      if (!next) continue
      const current = variable.type
      if (current.definition === next.definition && current.value === next.value) continue
      variable.type = { definition: next.definition, value: next.value } as VariantVariableType
      changed += 1
    }
  }
  return changed
}

/** Re-stamp the pin type each ladder pin node caches from its block's signature. */
function restampPinNodes(nodes: Array<BlockBearingNode & PinBearingNode>): number {
  const variantsByBlockId = new Map<string, BlockVariant>()
  for (const node of nodes) {
    const variant = node?.type === 'block' ? node.data?.variant : undefined
    const id = (node as { id?: string }).id
    if (variant && Array.isArray(variant.variables) && typeof id === 'string') variantsByBlockId.set(id, variant)
  }
  if (variantsByBlockId.size === 0) return 0

  let changed = 0
  for (const node of nodes) {
    if (node?.type !== 'variable') continue
    const block = node.data?.block
    if (!block?.id || !block.handleId) continue
    const variant = variantsByBlockId.get(block.id)
    if (!variant) continue

    const handleId = block.handleId.toUpperCase()
    const pin = variant.variables.find((variable) => variable.name.toUpperCase() === handleId)
    if (!pin) continue

    const current = block.variableType?.type
    if (current?.definition === pin.type.definition && current?.value === pin.type.value) continue
    block.variableType = { name: pin.name, class: pin.class, type: { ...pin.type } }
    changed += 1
  }
  return changed
}

/**
 * Re-stamp every block in the given flows from the current system libraries and
 * the project's own POUs. Mutates in place; call it on a clone of loaded data.
 *
 * @returns how many types were refreshed, for the load-time console note.
 */
export function restampFlowBlockVariants(
  flows: Array<{ rung?: { nodes?: unknown; edges?: unknown }; rungs?: Array<{ nodes?: unknown; edges?: unknown }> }>,
  systemLibraries: SystemLibrary[],
  userPous: PLCPou[],
): number {
  const libraryPousByName = indexLibraryPous(systemLibraries)
  const userPousByName = indexUserPous(userPous)
  if (libraryPousByName.size === 0 && userPousByName.size === 0) return 0

  let changed = 0
  for (const flow of flows) {
    const rungs = flow.rungs ?? (flow.rung ? [flow.rung] : [])
    for (const rung of rungs) {
      const nodes = rung?.nodes
      if (!Array.isArray(nodes)) continue
      changed += restampBlockNodes(
        nodes as BlockBearingNode[],
        Array.isArray(rung.edges) ? (rung.edges as RestampedEdge[]) : [],
        libraryPousByName,
        userPousByName,
        flow.rung === rung,
      )
      // After the blocks, so the pins copy the refreshed types.
      changed += restampPinNodes(nodes as Array<BlockBearingNode & PinBearingNode>)
    }
  }
  return changed
}

/**
 * Hydrate the authoritative project POU bodies BEFORE they are installed in
 * the project store. PLCopen carries the visible FBD pins and edges but not the
 * placed block's typed variant.variables signature. If only the separate
 * FBD/LD canvas flow is re-stamped, saving/building from project.data.pous
 * compiles the unhydrated block as RS0() even though the wires render correctly.
 *
 * Keep the project model and canvas seeded from the same hydrated body. Do not
 * mutate parser-owned input or mark a previously saved project as edited: this
 * is restoration of definition data, not a user change.
 */
export function hydrateLoadedGraphicalPous(
  pous: PLCPou[],
  systemLibraries: SystemLibrary[],
): { pous: PLCPou[]; changed: number } {
  const userPous = pous.filter((pou) => pou.pouType !== 'program')
  let changed = 0
  const hydratedPous = pous.map((pou) => {
    if (pou.body.language !== 'fbd' && pou.body.language !== 'ld') return pou
    // PLCProjectData leaves graphical body.value typed as `unknown`. The
    // fbd/ld language check above narrows the semantic format but not that
    // TypeScript field, so establish the structural flow shape explicitly.
    const bodyValue = structuredClone(pou.body.value)
    if (!bodyValue || typeof bodyValue !== 'object' || Array.isArray(bodyValue)) return pou
    const flow = bodyValue as Parameters<typeof restampFlowBlockVariants>[0][number]
    const refreshed = restampFlowBlockVariants([flow], systemLibraries, userPous)
    if (!refreshed) return pou
    changed += refreshed
    return { ...pou, body: { ...pou.body, value: bodyValue } } as PLCPou
  })
  return { pous: hydratedPous, changed }
}

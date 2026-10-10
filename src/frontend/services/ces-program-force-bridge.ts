import type { DebuggerPort } from '../../middleware/shared/ports/debugger-port'
import { useOpenPLCStore } from '../store'
import { forceDebugVariable, releaseDebugVariable } from './debug-force-variable'
import { encodeForceValue, isForcedValueHigh } from '../utils/variable-sizes'

// Only the parent CES page may control the iframe's *own* connected simulator.
// No HTTP mutation endpoint, runtime-service write, or retained force is created.
const MESSAGE_COMMAND = 'ces:simulator-force-command'
const MESSAGE_RESULT = 'ces:simulator-force-result'
const MESSAGE_STATE = 'ces:simulator-force-state'
const MESSAGE_STATE_REQUEST = 'ces:simulator-force-state-request'

const SUPPORTED_TYPES = new Set([
  'BOOL', 'SINT', 'USINT', 'BYTE', 'INT', 'UINT', 'WORD', 'DINT', 'UDINT', 'DWORD',
  'LINT', 'ULINT', 'LWORD', 'REAL', 'LREAL', 'TIME', 'STRING',
])

export function installCesProgramForceBridge(debuggerPort: DebuggerPort, host: Window = window): () => void {
  // Never enable the bridge in desktop/OpenPLC's standalone renderer.
  if (host.parent === host || !/\/editor-sessions\/[^/]+\/proxy\//.test(host.location.pathname)) {
    return () => undefined
  }

  const notify = (data: Record<string, unknown>) => host.parent.postMessage(data, host.location.origin)
  const publishState = () => {
    const workspace = useOpenPLCStore.getState().workspace
    notify({
      type: MESSAGE_STATE,
      active: debuggerPort.isConnected() && workspace.isDebuggerVisible,
      keys: Array.from(workspace.debugForcedVariables.keys()),
    })
  }
  const unsubscribe = useOpenPLCStore.subscribe((state, previous) => {
    if (state.workspace.debugForcedVariables !== previous.workspace.debugForcedVariables ||
        state.workspace.isDebuggerVisible !== previous.workspace.isDebuggerVisible ||
        state.workspace.debugVariableIndexes !== previous.workspace.debugVariableIndexes) publishState()
  })
  let disposed = false
  const onMessage = (event: MessageEvent) => {
    if (event.source !== host.parent || event.origin !== host.location.origin ||
        !event.data || typeof event.data !== 'object') return
    const data = event.data as Record<string, unknown>
    if (data.type === MESSAGE_STATE_REQUEST) { publishState(); return }
    if (data.type !== MESSAGE_COMMAND) return
    const requestId = data.requestId
    if (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 100) return

    const respond = (ok: boolean, error?: string) => {
      if (!disposed) {
        notify({ type: MESSAGE_RESULT, requestId, ok, error: error ?? '' })
        publishState()
      }
    }
    const run = async () => {
      const workspace = useOpenPLCStore.getState().workspace
      if (!debuggerPort.isConnected() || !workspace.isDebuggerVisible) throw new Error('Simulator debugger is not connected')
      const key = data.key
      const action = data.action
      if (typeof key !== 'string' || key.length > 250 || key.length < 3 ||
          (action !== 'force' && action !== 'release')) throw new Error('Invalid force request')
      const index = workspace.debugVariableIndexes.get(key)
      if (index === undefined) throw new Error('Variable is not available in the running debugger')
      const separator = key.indexOf(':')
      const pouName = key.slice(0, separator)
      const variableName = key.slice(separator + 1)
      const pou = useOpenPLCStore.getState().project.data.pous.find(
        (item) => item.pouType === 'program' && item.name === pouName,
      )
      const variable = pou?.interface?.variables.find((item) => item.name === variableName)
      if (!variable || variable.type.definition !== 'base-type') {
        throw new Error('Only declared Program variables with elementary IEC types may be forced')
      }
      const actualType = variable.type.value.toUpperCase()
      if (!SUPPORTED_TYPES.has(actualType)) throw new Error(`Forcing ${actualType} is unsupported`)
      if (data.valueType !== actualType) throw new Error('Variable type differs from CES snapshot; refresh values')
      if (action === 'release') {
        if (!await releaseDebugVariable(debuggerPort, key, index)) throw new Error('Native debugger rejected release')
      } else {
        if (typeof data.value !== 'string' || data.value.length > 256) throw new Error('Invalid force value')
        const encoded = encodeForceValue(data.value, actualType)
        if (!await forceDebugVariable(debuggerPort, key, index, encoded, isForcedValueHigh(data.value), actualType)) {
          throw new Error('Native debugger rejected force')
        }
      }
    }
    void run().then(() => respond(true)).catch((error: unknown) => respond(false, error instanceof Error ? error.message : String(error)))
  }
  host.addEventListener('message', onMessage)
  publishState()
  return () => { disposed = true; host.removeEventListener('message', onMessage); unsubscribe() }
}

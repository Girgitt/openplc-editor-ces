import { useEffect, useRef } from 'react'

import { useExternalSymbolsPort } from '../middleware/shared/providers/platform-context'
import { useOpenPLCStore } from '../frontend/store'
import { buildGlobalCompositeKey } from '../frontend/utils/debug-variable-finder'
import { cesApi, type CesLiveSnapshot, isCesWebEnvironment } from './api'

export function CesLivePreviewAgent() {
  const symbolsPort = useExternalSymbolsPort()
  const projectPath = useOpenPLCStore((state) => state.project.meta.path)
  const lastRevision = useRef<number | null>(null)

  useEffect(() => {
    if (!isCesWebEnvironment() || !projectPath || !symbolsPort) return undefined
    let cancelled = false
    let timer: number | undefined

    const poll = async () => {
      try {
        const snapshot = await cesApi<CesLiveSnapshot>('/api/live/snapshot')
        if (!cancelled && snapshot.revision !== lastRevision.current) {
          const state = useOpenPLCStore.getState()
          // M5-3 native simulator/debug values take precedence over the older
          // S1C read-only preview overlay. Do not advance lastRevision while a
          // simulator debug session is active: when it stops, the same preview
          // revision is intentionally replayed and editing returns to the
          // deterministic preview source without a separate reconnect step.
          const nativeSimulatorDebug =
            state.workspace.isDebuggerVisible && state.deviceConnection.debugTransport === 'simulator'
          if (nativeSimulatorDebug) {
            // Leave the native debugger's store state untouched.
          } else {
            lastRevision.current = snapshot.revision
            if (!snapshot.active) {
              state.workspaceActions.clearDebugState()
            } else {
              const symbols = await symbolsPort.list()
              const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]))
              const valuesByBinding = new Map<string, string>()
              for (const item of snapshot.values) {
                const symbol = byId.get(item.id)
                if (symbol) valuesByBinding.set(symbol.binding, item.value)
              }

              const boolValues = new Map<string, string>()
              const nonBoolValues = new Map<string, string>()
              for (const pou of state.project.data.pous) {
                for (const variable of pou.interface?.variables ?? []) {
                  const value = valuesByBinding.get(variable.location)
                  if (value === undefined) continue
                  const target = variable.type.value.toUpperCase() === 'BOOL' ? boolValues : nonBoolValues
                  target.set(`${pou.name}:${variable.name}`, value)
                }
              }
              for (const variable of state.project.data.configurations.resource.globalVariables) {
                const value = valuesByBinding.get(variable.location)
                if (value === undefined) continue
                const target = variable.type.value.toUpperCase() === 'BOOL' ? boolValues : nonBoolValues
                target.set(buildGlobalCompositeKey(variable.name), value)
              }

              // Preview is read-only: no debug indexes or forced-variable state are provided.
              state.workspaceActions.clearDebugState()
              state.workspaceActions.setDebuggerVisible(true)
              state.workspaceActions.setDebugValues({ boolValues, nonBoolValues })
            }
          }
        }
      } catch {
        // Keep editing usable if CES temporarily cannot provide a preview snapshot.
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), 750)
    }

    void poll()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [projectPath, symbolsPort])

  return null
}

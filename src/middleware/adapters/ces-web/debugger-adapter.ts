import { cesApi } from './http'
import { openPLCStoreBase } from '@root/frontend/store'
import type { DebuggerPort } from '@root/middleware/shared/ports/debugger-port'
import type { DebugSetResult, DebugVariableResult, Md5VerifyResult, Unsubscribe } from '@root/middleware/shared/ports/types'

import { cesWebSimulationRuntime } from './simulation-runtime'

export function createCesWebDebuggerAdapter(): DebuggerPort {
  // The editor server outlives renderer reloads inside one CES session. Clear any
  // mirror left by a renderer that disappeared without a clean debugger teardown.
  void cesApi('/api/simulator/live/clear', { method: 'POST', body: '{}' }).catch(() => undefined)

  let connected = false
  const disconnectCallbacks: Array<() => void> = []
  let unsubscribeStore: (() => void) | null = null
  let publishTimer: ReturnType<typeof setTimeout> | null = null
  let lastPublished = ''

  const publishSnapshot = async (): Promise<void> => {
    publishTimer = null
    if (!connected) return
    const workspace = openPLCStoreBase.getState().workspace
    const values = [
      ...Array.from(workspace.debugBoolValues.entries()),
      ...Array.from(workspace.debugNonBoolValues.entries()),
    ]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({ key, value }))
    const signature = JSON.stringify(values)
    if (signature === lastPublished) return
    lastPublished = signature
    try {
      await cesApi('/api/simulator/live', { method: 'POST', body: JSON.stringify({ values }) })
    } catch {
      // The native editor debugger remains authoritative. A transient failure to
      // mirror values to CES must not tear down the simulation/debug session.
    }
  }

  const scheduleSnapshot = (): void => {
    if (!connected || publishTimer !== null) return
    publishTimer = setTimeout(() => void publishSnapshot(), 200)
  }

  const startSnapshotPublication = (): void => {
    unsubscribeStore?.()
    unsubscribeStore = openPLCStoreBase.subscribe((state, previous) => {
      if (
        state.workspace.debugBoolValues !== previous.workspace.debugBoolValues ||
        state.workspace.debugNonBoolValues !== previous.workspace.debugNonBoolValues
      ) {
        scheduleSnapshot()
      }
    })
    scheduleSnapshot()
  }

  const stopSnapshotPublication = (): void => {
    unsubscribeStore?.()
    unsubscribeStore = null
    if (publishTimer !== null) {
      clearTimeout(publishTimer)
      publishTimer = null
    }
    lastPublished = ''
    void cesApi('/api/simulator/live/clear', { method: 'POST', body: '{}' }).catch(() => undefined)
  }

  return {
    async connect() {
      try {
        await cesWebSimulationRuntime.connectDebugger()
        connected = true
        startSnapshotPublication()
        openPLCStoreBase.getState().deviceActions.setDeviceConnectionStatus(
          'connected',
          'OpenPLC Simulator',
          'simulator',
          'simulator',
        )
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },

    async disconnect() {
      cesWebSimulationRuntime.disconnectDebugger()
      connected = false
      stopSnapshotPublication()
      for (const callback of [...disconnectCallbacks]) callback()
      return { success: true }
    },

    async getVariablesList(indexes: number[]): Promise<DebugVariableResult> {
      const result = await cesWebSimulationRuntime.variables(indexes)
      if (!result.success) return { success: false, error: result.error }
      return {
        success: true,
        tick: result.tick,
        lastIndex: result.lastIndex,
        data: result.data ? Array.from(result.data) : undefined,
      }
    },

    async setVariable(index: number, force: boolean, valueBuffer?: Uint8Array): Promise<DebugSetResult> {
      return cesWebSimulationRuntime.setVariable(index, force, valueBuffer)
    },

    async verifyMd5(expectedMd5: string): Promise<Md5VerifyResult> {
      try {
        const targetMd5 = await cesWebSimulationRuntime.targetMd5()
        return { success: true, match: targetMd5.toLowerCase() === expectedMd5.toLowerCase(), targetMd5, targetEndian: 'le' }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },

    async readProgramMd5() {
      const artifacts = cesWebSimulationRuntime.getBuildArtifacts()
      return artifacts ? { success: true, md5: artifacts.md5 } : { success: false, error: 'No simulator build artifacts are available.' }
    },

    async readDebugFile() {
      const artifacts = cesWebSimulationRuntime.getBuildArtifacts()
      return artifacts ? { success: true, content: artifacts.debugMap } : { success: false, error: 'No simulator build artifacts are available.' }
    },

    onDisconnected(callback: () => void): Unsubscribe {
      disconnectCallbacks.push(callback)
      const unsubscribeStopped = cesWebSimulationRuntime.onStopped(() => {
        connected = false
        stopSnapshotPublication()
        callback()
      })
      return () => {
        unsubscribeStopped()
        const index = disconnectCallbacks.indexOf(callback)
        if (index >= 0) disconnectCallbacks.splice(index, 1)
      }
    },

    isConnected(): boolean {
      return connected && cesWebSimulationRuntime.isDebuggerConnected()
    },
  }
}

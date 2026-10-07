import { openPLCStoreBase } from '@root/frontend/store'
import type { SimulatorPort } from '@root/middleware/shared/ports/simulator-port'
import type { SimulatorDebugResult, Unsubscribe } from '@root/middleware/shared/ports/types'

import { cesWebSimulationRuntime } from './simulation-runtime'

export function createCesWebSimulatorAdapter(): SimulatorPort {
  return {
    async loadFirmware(_firmwareToken: string): Promise<{ success: boolean; error?: string }> {
      try {
        await cesWebSimulationRuntime.start()
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

    async stop(): Promise<{ success: boolean }> {
      await cesWebSimulationRuntime.stop()
      openPLCStoreBase.getState().deviceActions.clearDeviceConnection()
      return { success: true }
    },

    isRunning(): boolean {
      return cesWebSimulationRuntime.isRunning()
    },

    onStopped(callback: () => void): Unsubscribe {
      return cesWebSimulationRuntime.onStopped(callback)
    },

    async connectDebugger(): Promise<void> {
      await cesWebSimulationRuntime.connectDebugger()
    },

    disconnectDebugger(): void {
      cesWebSimulationRuntime.disconnectDebugger()
    },

    async getDebugMd5Hash(): Promise<string> {
      return cesWebSimulationRuntime.targetMd5()
    },

    async getDebugVariablesList(indexes: number[]): Promise<SimulatorDebugResult> {
      const result = await cesWebSimulationRuntime.variables(indexes)
      if (!result.success) return { success: false, error: result.error }
      return {
        success: true,
        tick: result.tick,
        lastIndex: result.lastIndex,
        data: result.data ? cesWebSimulationRuntime.bytesToHex(result.data) : undefined,
      }
    },

    async setDebugVariable(index: number, force: boolean, valueHex?: string) {
      const value = force && valueHex ? cesWebSimulationRuntime.hexToBytes(valueHex) : undefined
      return cesWebSimulationRuntime.setVariable(index, force, value)
    },
  }
}

import { ModbusRtuClient } from '@root/backend/shared/simulator/modbus-rtu-client'
import { SimulatorModule } from '@root/backend/shared/simulator/simulator-module'
import { VirtualSerialPort } from '@root/backend/shared/simulator/virtual-serial-port'
import { bytesToHex, hexToBytes } from '@root/frontend/utils/hex'

export interface CesSimulatorBuildArtifacts {
  firmwareHex: string
  debugMap: string
  md5: string
}

class CesWebSimulationRuntime {
  private simulator = new SimulatorModule()
  private client: ModbusRtuClient | null = null
  private artifacts: CesSimulatorBuildArtifacts | null = null
  private stopCallbacks: Array<() => void> = []

  setBuildArtifacts(artifacts: CesSimulatorBuildArtifacts): void {
    this.artifacts = artifacts
  }

  getBuildArtifacts(): CesSimulatorBuildArtifacts | null {
    return this.artifacts
  }

  async start(): Promise<void> {
    if (!this.artifacts) throw new Error('Build the simulator program before starting it.')
    this.disconnectDebugger()
    this.simulator.loadAndRun(this.artifacts.firmwareHex)
  }

  async stop(): Promise<void> {
    this.disconnectDebugger()
    const wasRunning = this.simulator.isRunning()
    this.simulator.stop()
    if (wasRunning) this.emitStopped()
  }

  isRunning(): boolean {
    return this.simulator.isRunning()
  }

  async connectDebugger(): Promise<void> {
    if (!this.simulator.isRunning()) throw new Error('Simulator is not running')
    this.disconnectDebugger()
    const port = new VirtualSerialPort(this.simulator)
    const client = new ModbusRtuClient({ slaveId: 1, timeout: 5000, serialPort: port })
    await client.connect()
    this.client = client
  }

  disconnectDebugger(): void {
    this.client?.disconnect()
    this.client = null
  }

  isDebuggerConnected(): boolean {
    return this.client !== null
  }

  async targetMd5(): Promise<string> {
    if (!this.client) throw new Error('Simulator debugger is not connected')
    return (await this.client.getMd5Hash()).md5
  }

  async variables(indexes: number[]) {
    if (!this.client) return { success: false as const, error: 'Simulator debugger is not connected' }
    return this.client.getVariablesList(indexes)
  }

  async setVariable(index: number, force: boolean, value?: Uint8Array) {
    if (!this.client) return { success: false as const, error: 'Simulator debugger is not connected' }
    return this.client.setVariable(index, force, value)
  }

  onStopped(callback: () => void): () => void {
    this.stopCallbacks.push(callback)
    return () => {
      this.stopCallbacks = this.stopCallbacks.filter((candidate) => candidate !== callback)
    }
  }

  private emitStopped(): void {
    for (const callback of [...this.stopCallbacks]) callback()
  }

  bytesToHex(bytes: Uint8Array): string {
    return bytesToHex(bytes)
  }

  hexToBytes(hex: string): Uint8Array {
    return hexToBytes(hex)
  }
}

export const cesWebSimulationRuntime = new CesWebSimulationRuntime()

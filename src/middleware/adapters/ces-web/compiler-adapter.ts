import type { CompilerPort } from '@root/middleware/shared/ports/compiler-port'
import type { CompileProgressEvent, CompileResult, DebugCompileResult } from '@root/middleware/shared/ports/types'

import { cesApi } from './http'
import { cesWebSimulationRuntime, type CesSimulatorBuildArtifacts } from './simulation-runtime'

const SIMULATOR_BOARD = 'OpenPLC Simulator'
const FIRMWARE_TOKEN = 'ces-simulator://latest'

type BuildResponse = CesSimulatorBuildArtifacts & {
  success: boolean
  logs?: string[]
  error?: string
}

function progress(onProgress: (event: CompileProgressEvent) => void, event: CompileProgressEvent): void {
  onProgress(event)
}

async function build(onProgress: (event: CompileProgressEvent) => void): Promise<BuildResponse> {
  progress(onProgress, { stage: 'xml', message: 'Preparing canonical project for OpenPLC Simulator…', progress: 5 })
  const result = await cesApi<BuildResponse>('/api/simulator/build', { method: 'POST', body: '{}' })
  for (const line of result.logs ?? []) {
    progress(onProgress, { stage: 'arduino', message: line, level: 'info' })
  }
  if (!result.success) throw new Error(result.error ?? 'Simulator build failed')
  cesWebSimulationRuntime.setBuildArtifacts({ firmwareHex: result.firmwareHex, debugMap: result.debugMap, md5: result.md5 })
  return result
}

export function createCesWebCompilerAdapter(): CompilerPort {
  return {
    async compileProgram(args, onProgress): Promise<CompileResult> {
      if (args.boardTarget !== SIMULATOR_BOARD) {
        return { success: false, error: `CES web M5-3 supports only ${SIMULATOR_BOARD}; got ${args.boardTarget || '(none)'}.` }
      }
      try {
        const result = await build(onProgress)
        progress(onProgress, {
          stage: 'done',
          message: 'OpenPLC Simulator firmware built.',
          progress: 100,
          firmwarePath: FIRMWARE_TOKEN,
        })
        return { success: true, message: 'Simulator firmware built.', hexPath: FIRMWARE_TOKEN }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        progress(onProgress, { stage: 'error', message, level: 'error' })
        return { success: false, error: message }
      }
    },

    async compileForDebug(args, onProgress): Promise<DebugCompileResult> {
      if (args.boardTarget !== SIMULATOR_BOARD) {
        return { success: false, error: `CES web M5-3 supports debug compilation only for ${SIMULATOR_BOARD}.` }
      }
      try {
        const result = await build(onProgress)
        return { success: true, debugContent: result.debugMap, md5: result.md5 }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        progress(onProgress, { stage: 'error', message, level: 'error' })
        return { success: false, error: message }
      }
    },

    async exportProjectXml() {
      return { success: false, error: 'Use the CES canonical PLCopen save/export boundary.' }
    },
  }
}

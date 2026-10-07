import { openPLCStoreBase } from '@root/frontend/store'
import { validateFbdRung } from '@root/frontend/utils/PLC/graphical/fbd-edge-integrity'
import type { CompilerPort } from '@root/middleware/shared/ports/compiler-port'
import type {
  CompileProgressEvent,
  CompileResult,
  DebugCompileResult,
  PLCProjectData,
} from '@root/middleware/shared/ports/types'

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

function installSimulatorDebugInstanceOverlay(projectData: PLCProjectData): void {
  const actions = openPLCStoreBase.getState().workspaceActions
  const persistedInstances = projectData.configurations.resource.instances
  if (persistedInstances.length > 0) {
    actions.setDebugInstanceOverlay(null)
    return
  }

  // The CES build host synthesises exactly one cyclic simulator instance when
  // the engineering project intentionally contains no OpenPLC runtime schedule.
  // Mirror that schedule only for the debugger, using the logical/editor POU
  // name rather than any IEC-safe alias used inside the transient build copy.
  const rootProgram = projectData.pous.find((pou) => pou.pouType === 'program')
  actions.setDebugInstanceOverlay(
    rootProgram ? [{ name: 'instance0', program: rootProgram.name, task: 'task0' }] : null,
  )
}

function validateSimulatorFbd(projectData: PLCProjectData): void {
  // The simulator executes the last saved canonical PLCopen. Never start a new
  // build while a visible in-memory wire points at a nonexistent formal pin.
  for (const pou of projectData.pous) {
    if (pou.body.language !== 'fbd') continue
    const value = pou.body.value as { rung?: Parameters<typeof validateFbdRung>[0] } | undefined
    if (value?.rung) validateFbdRung(value.rung)
  }
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
        openPLCStoreBase.getState().workspaceActions.setDebugInstanceOverlay(null)
        validateSimulatorFbd(args.projectData)
        const result = await build(onProgress)
        installSimulatorDebugInstanceOverlay(args.projectData)
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
        openPLCStoreBase.getState().workspaceActions.setDebugInstanceOverlay(null)
        validateSimulatorFbd(args.projectData)
        const result = await build(onProgress)
        installSimulatorDebugInstanceOverlay(args.projectData)
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

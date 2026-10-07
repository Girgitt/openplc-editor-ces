import { generatePlcopenXml } from '../frontend/services/export-actions'
import { buildAllProjectFileContentsPure } from '../frontend/services/save-actions'
import { openPLCStoreBase } from '../frontend/store'
import type { WriteProjectFiles } from '../middleware/shared/ports/project-port'
import type { BoardInfo } from '../middleware/shared/ports/types'
import { cesApi } from './api'

type Bridge = Window['bridge']

const unsubscribe = () => undefined
const subscription = (_callback?: unknown) => unsubscribe

function saveFileAccelerator(callback: (...args: unknown[]) => void): () => void {
  const listener = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 's') return
    // Electron normally owns Ctrl/Cmd+S through the application menu. In the
    // browser build there is no menu accelerator, so without this explicit
    // listener the browser handles it as "Save page as...".
    event.preventDefault()
    event.stopPropagation()
    callback()
  }
  window.addEventListener('keydown', listener, true)
  return () => window.removeEventListener('keydown', listener, true)
}


const CES_SIMULATOR_BOARD = 'OpenPLC Simulator'

function cesSimulatorBoards(): Map<string, BoardInfo> {
  return new Map([
    [
      CES_SIMULATOR_BOARD,
      {
        compiler: 'simulator',
        core: 'arduino:avr',
        platform: 'arduino:avr:mega',
        preview: 'simulator.png',
        specs: {
          CPU: 'Emulated ATmega2560 at 16MHz',
          RAM: '63.5 KB',
          Flash: '256 KB',
          'Digital Pins': '70',
          'Analog Pins': '16',
          'PWM Pins': '15',
          WiFi: 'No',
          Bluetooth: 'No',
          Ethernet: 'No',
        },
        capabilities: {
          pinMapping: false,
          vppIo: false,
          modbusTcpRemote: true,
          ethercat: true,
          modbusTcpServer: true,
          opcuaServer: true,
          s7Server: true,
          debuggerTransports: ['modbus-serial'],
          pythonFunctionBlocks: true,
          arduinoApiCompletions: true,
          hasRuntimeStats: false,
          isInProcessSimulator: true,
          directUsbUpload: true,
        },
        debug: {
          channels: [{ label: 'Simulator', channel: 'simulator', enabledWhen: true, params: {} }],
        },
      },
    ],
  ])
}

type BundledLibraryResponse = {
  archives?: unknown[]
  installed?: unknown[]
}

async function bundledLibraries(): Promise<BundledLibraryResponse> {
  return (await cesApi('/api/context/libraries')) as BundledLibraryResponse
}

function osName(): 'linux' | 'darwin' | 'win32' | '' {
  const p = navigator.platform.toLowerCase()
  if (p.includes('mac')) return 'darwin'
  if (p.includes('win')) return 'win32'
  if (p.includes('linux')) return 'linux'
  return ''
}

function asyncUnsupported(name: string) {
  return Promise.resolve({ success: false, error: `Operation ${name} is unavailable in CES web editor mode.` })
}

export function isEmbeddedCesEditorSession(): boolean {
  if (typeof window === 'undefined') return false
  return /\/editor-sessions\/[^/]+\/proxy\/?$/.test(window.location.pathname)
}

async function saveCanonicalSnapshot(): Promise<void> {
  if (!isEmbeddedCesEditorSession()) return
  const generated = generatePlcopenXml(openPLCStoreBase.getState().project.data)
  if (!generated.success) throw new Error(generated.error)
  await cesApi('../canonical-save', {
    method: 'POST',
    body: JSON.stringify({ xml: generated.xml }),
  })
}

async function saveProjectFiles(files: unknown): Promise<{ success: boolean; error?: string }> {
  try {
    if (isEmbeddedCesEditorSession()) {
      await saveCanonicalSnapshot()
      // The raw editor project is transient build input only. CES canonical PLCopen
      // remains the persistence authority; M5-3 uses this snapshot exclusively to
      // invoke the existing OpenPLC simulator compiler.
      // `files` may contain byte-identical raw fallbacks for untouched POUs
      // (version-control's preservation contract). Those bytes can predate
      // PLCopen block-signature hydration: a freshly opened FBD still draws
      // S/R1 wires, but its raw compiler input emits RS0() with no arguments.
      // Feed the simulator the fresh, hydrated POU serialization instead. This
      // is a transient build snapshot; do NOT change canonical-save or the
      // version-control raw-file preservation behavior.
      const fresh = buildAllProjectFileContentsPure()
      const pending = files as WriteProjectFiles
      const simulatorFiles: WriteProjectFiles = {
        ...pending,
        // Preserve the original payload shape when callers supply no POU list.
        ...(Array.isArray(pending.pouFiles) ? {
          pouFiles: pending.pouFiles.map((entry) => {
            const content = fresh[entry.relativePath]
            if (content === undefined) {
              throw new Error(`Cannot build simulator: current serialization is missing for POU ${entry.relativePath}.`)
            }
            return { ...entry, content }
          }),
        } : {}),
      }
      await cesApi('/api/simulator/project', { method: 'POST', body: JSON.stringify(simulatorFiles) })
      return { success: true }
    }
    await cesApi('/api/document/save', { method: 'POST', body: JSON.stringify(files) })
    await cesApi('/api/simulator/project', { method: 'POST', body: JSON.stringify(files) })
    return { success: true }
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function saveSingleFile(filePath: string, content: unknown): Promise<{ success: boolean; error?: string }> {
  try {
    if (isEmbeddedCesEditorSession()) {
      await saveCanonicalSnapshot()
      return { success: true }
    }
    await cesApi('/api/document/save-file', {
      method: 'POST',
      body: JSON.stringify({
        filePath,
        content: typeof content === 'string' ? content : JSON.stringify(content ?? null, null, 2),
      }),
    })
    return { success: true }
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function installCesWebBridge(): void {
  window.__OPENPLC_CES_WEB__ = true

  const implementation: Record<string, unknown> = {
    readProjectFiles: async () => cesApi('/api/document/raw'),
    writeProjectFiles: saveProjectFiles,
    saveFile: saveSingleFile,
    retrieveRecent: async () => [],
    getRecent: async () => [],
    removeProjectFromRecent: async () => ({ success: true }),
    trackRecentProject: async () => ({ success: true }),
    getSystemInfo: async () => ({
      OS: osName(),
      architecture: '',
      prefersDarkMode: window.matchMedia('(prefers-color-scheme: dark)').matches,
      isWindowMaximized: false,
    }),
    getStoreValue: async (key: string) => localStorage.getItem(key),
    setStoreValue: (key: string, value: string) => localStorage.setItem(key, value),
    openExternalLinkAccelerator: async (url: string) => {
      window.open(url, '_blank', 'noopener,noreferrer')
      return { success: true }
    },
    log: (level: string, message: string) => (level === 'error' ? console.error(message) : console.info(message)),
    winGetTheme: async () => null,
    winHandleUpdateTheme: () => undefined,
    handleUpdateTheme: subscription,
    onLibrariesChanged: subscription,
    saveFileAccelerator,
    onEdgeAccountSignedIn: subscription,
    loadAllLibraries: async () => (await bundledLibraries()).archives ?? [],
    listInstalledLibraries: async () => (await bundledLibraries()).installed ?? [],
    listInstalledPackages: async () => [],
    verifyInstalledPackageSignatures: async () => [],
    getAvailableBoards: async () => cesSimulatorBoards(),
    getAvailableCommunicationPorts: async () => [],
    refreshAvailableBoards: async () => [{ board: CES_SIMULATOR_BOARD, version: '' }],
    refreshCommunicationPorts: async () => [],
    setMenuProjectOpen: () => undefined,
    openPathPicker: async () => ({ success: false, error: { title: 'Unavailable', description: 'CES supplies the document.' } }),
    pathPicker: async () => ({ success: false, error: { title: 'Unavailable', description: 'CES supplies the document.' } }),
    pickPlcopenImportFile: async () => ({ success: false, error: 'CES supplies the document.' }),
    exportPlcopenFile: async () => ({ success: false, error: 'Use the CES document save contract.' }),
  }

  const proxy = new Proxy(implementation, {
    get(target, prop) {
      const name = String(prop)
      if (name in target) return target[name]
      if (
        name.startsWith('on') ||
        name.endsWith('Accelerator') ||
        name.endsWith('Request') ||
        name === 'quitRequested' ||
        name === 'windowIsClosing' ||
        name === 'isMaximizedWindow'
      ) {
        return subscription
      }
      if (
        name.startsWith('set') ||
        name.startsWith('winHandle') ||
        name.startsWith('handle') ||
        name.startsWith('rebuild') ||
        name.startsWith('reload') ||
        name.startsWith('minimize') ||
        name.startsWith('maximize') ||
        name.startsWith('hide')
      ) {
        return () => undefined
      }
      return (..._args: unknown[]) => asyncUnsupported(name)
    },
  })

  window.bridge = proxy as unknown as Bridge
}

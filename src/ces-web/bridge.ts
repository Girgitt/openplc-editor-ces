import { generatePlcopenXml } from '../frontend/services/export-actions'
import { openPLCStoreBase } from '../frontend/store'
import { cesApi } from './api'

type Bridge = Window['bridge']

const unsubscribe = () => undefined
const subscription = (_callback?: unknown) => unsubscribe

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
      return { success: true }
    }
    await cesApi('/api/document/save', { method: 'POST', body: JSON.stringify(files) })
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
    onEdgeAccountSignedIn: subscription,
    loadAllLibraries: async () => [],
    listInstalledLibraries: async () => [],
    listInstalledPackages: async () => [],
    verifyInstalledPackageSignatures: async () => [],
    getAvailableBoards: async () => new Map(),
    getAvailableCommunicationPorts: async () => [],
    refreshAvailableBoards: async () => new Map(),
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

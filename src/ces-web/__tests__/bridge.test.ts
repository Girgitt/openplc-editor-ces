/** @jest-environment jsdom */

const mockCesApi = vi.fn()
vi.mock('../api', () => ({
  cesApi: (...args: unknown[]) => mockCesApi(...args),
}))

const mockGeneratePlcopenXml = vi.fn()
vi.mock('../../frontend/services/export-actions', () => ({
  generatePlcopenXml: (...args: unknown[]) => mockGeneratePlcopenXml(...args),
}))

const mockBuildFresh = vi.fn()
vi.mock('../../frontend/services/save-actions', () => ({
  buildAllProjectFileContentsPure: () => mockBuildFresh(),
}))

const projectData = { pous: [] }
vi.mock('../../frontend/store', () => ({
  openPLCStoreBase: {
    getState: () => ({ project: { data: projectData } }),
  },
}))

import { installCesWebBridge } from '../bridge'

beforeEach(() => {
  vi.clearAllMocks()
  mockGeneratePlcopenXml.mockReturnValue({ success: true, xml: '<project/>' })
  mockBuildFresh.mockReturnValue({})
  mockCesApi.mockResolvedValue({ success: true })
})

describe('CES embedded editor canonical save bridge', () => {
  it('saves canonical PLCopen and refreshes only a transient simulator build snapshot in embedded mode', async () => {
    window.history.replaceState({}, '', '/api/v1/projects/p/editor-sessions/s/proxy/')
    installCesWebBridge()

    const result = await window.bridge.writeProjectFiles({ projectPath: '/ces-session' } as never)

    expect(result).toEqual({ success: true })
    expect(mockCesApi).toHaveBeenCalledTimes(2)
    expect(mockCesApi).toHaveBeenNthCalledWith(1, '../canonical-save', {
      method: 'POST',
      body: JSON.stringify({ xml: '<project/>' }),
    })
    expect(mockCesApi).toHaveBeenNthCalledWith(2, '/api/simulator/project', {
      method: 'POST',
      body: JSON.stringify({ projectPath: '/ces-session' }),
    })
  })

  it('compiles the hydrated POU instead of byte-preserved pre-hydration raw content', async () => {
    window.history.replaceState({}, '', '/api/v1/projects/p/editor-sessions/s/proxy/')
    installCesWebBridge()
    const path = 'pous/programs/test-fbd-3.fbd'
    const raw = '{"body":"RS0()"}'
    const hydrated = '{"body":"RS0(S := v1, R1 := v2)"}'
    mockBuildFresh.mockReturnValue({ [path]: hydrated })
    const input = { projectPath: '/ces-session', pouFiles: [{ relativePath: path, content: raw }] }

    const result = await window.bridge.writeProjectFiles(input as never)
    expect(result).toEqual({ success: true })
    expect(mockCesApi).toHaveBeenNthCalledWith(1, '../canonical-save', {
      method: 'POST', body: JSON.stringify({ xml: '<project/>' }),
    })
    expect(mockCesApi).toHaveBeenNthCalledWith(2, '/api/simulator/project', {
      method: 'POST', body: JSON.stringify({ ...input, pouFiles: [{ relativePath: path, content: hydrated }] }),
    })
    // The original save payload remains unmodified for raw-file preservation.
    expect(input.pouFiles[0].content).toBe(raw)
  })

  it('refuses stale raw POU content when fresh serialization is unavailable', async () => {
    window.history.replaceState({}, '', '/api/v1/projects/p/editor-sessions/s/proxy/')
    installCesWebBridge()
    const input = { projectPath: '/ces-session', pouFiles: [{ relativePath: 'pous/programs/test-fbd-3.fbd', content: 'RS0()' }] }

    await expect(window.bridge.writeProjectFiles(input as never)).resolves.toEqual({
      success: false,
      error: expect.stringContaining('current serialization is missing'),
    })
    expect(mockCesApi).toHaveBeenCalledTimes(1)
    expect(mockCesApi).toHaveBeenCalledWith('../canonical-save', expect.any(Object))
  })

  it('does not update the transient document when canonical save is rejected', async () => {
    window.history.replaceState({}, '', '/api/v1/projects/p/editor-sessions/s/proxy/')
    mockCesApi.mockRejectedValueOnce(new Error('canonical conflict'))
    installCesWebBridge()

    const result = await window.bridge.writeProjectFiles({ projectPath: '/ces-session' } as never)

    expect(result).toEqual({ success: false, error: 'canonical conflict' })
    expect(mockCesApi).toHaveBeenCalledTimes(1)
  })

  it('keeps standalone CES-web saves on the existing raw document contract', async () => {
    window.history.replaceState({}, '', '/')
    installCesWebBridge()

    const result = await window.bridge.writeProjectFiles({ projectPath: '/ces-session' } as never)

    expect(result).toEqual({ success: true })
    expect(mockGeneratePlcopenXml).not.toHaveBeenCalled()
    expect(mockCesApi).toHaveBeenCalledTimes(2)
    expect(mockCesApi).toHaveBeenNthCalledWith(1, '/api/document/save', expect.any(Object))
    expect(mockCesApi).toHaveBeenNthCalledWith(2, '/api/simulator/project', expect.any(Object))
  })
  it('intercepts Ctrl+S and forwards it to the editor save-file accelerator', () => {
    window.history.replaceState({}, '', '/api/v1/projects/p/editor-sessions/s/proxy/')
    installCesWebBridge()
    const callback = vi.fn()
    const dispose = window.bridge.saveFileAccelerator(callback)

    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true })
    window.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(callback).toHaveBeenCalledTimes(1)
    dispose()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true }))
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('hydrates bundled libraries from the CES web server', async () => {
    window.history.replaceState({}, '', '/api/v1/projects/p/editor-sessions/s/proxy/')
    mockCesApi.mockImplementation(async (path: string) =>
      path === '/api/context/libraries'
        ? { archives: [{ manifest: { name: 'iec-standard-fb' } }], installed: [{ name: 'iec-standard-fb', bundled: true }] }
        : { success: true },
    )
    installCesWebBridge()

    await expect(window.bridge.loadAllLibraries()).resolves.toEqual([{ manifest: { name: 'iec-standard-fb' } }])
    await expect(window.bridge.listInstalledLibraries()).resolves.toEqual([{ name: 'iec-standard-fb', bundled: true }])
  })

  it('exposes the built-in OpenPLC Simulator board in CES web mode', async () => {
    installCesWebBridge()
    const boards = await window.bridge.getAvailableBoards()
    expect(boards.get('OpenPLC Simulator')).toMatchObject({
      compiler: 'simulator',
      capabilities: { isInProcessSimulator: true },
    })
  })

})

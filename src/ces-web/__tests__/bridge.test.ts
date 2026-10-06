/** @jest-environment jsdom */

const mockCesApi = vi.fn()
vi.mock('../api', () => ({
  cesApi: (...args: unknown[]) => mockCesApi(...args),
}))

const mockGeneratePlcopenXml = vi.fn()
vi.mock('../../frontend/services/export-actions', () => ({
  generatePlcopenXml: (...args: unknown[]) => mockGeneratePlcopenXml(...args),
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
  mockCesApi.mockResolvedValue({ success: true })
})

describe('CES embedded editor canonical save bridge', () => {
  it('uses canonical PLCopen as the only persistence write in embedded mode', async () => {
    window.history.replaceState({}, '', '/api/v1/projects/p/editor-sessions/s/proxy/')
    installCesWebBridge()

    const result = await window.bridge.writeProjectFiles({ projectPath: '/ces-session' } as never)

    expect(result).toEqual({ success: true })
    expect(mockCesApi).toHaveBeenCalledTimes(1)
    expect(mockCesApi).toHaveBeenCalledWith('../canonical-save', {
      method: 'POST',
      body: JSON.stringify({ xml: '<project/>' }),
    })
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
    expect(mockCesApi).toHaveBeenCalledTimes(1)
    expect(mockCesApi).toHaveBeenCalledWith('/api/document/save', expect.any(Object))
  })
})

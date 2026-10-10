import { installCesProgramForceBridge } from '../ces-program-force-bridge'
import { forceDebugVariable, releaseDebugVariable } from '../debug-force-variable'
import { useOpenPLCStore } from '../../store'
import type { DebuggerPort } from '../../../middleware/shared/ports/debugger-port'

jest.mock('../../store', () => ({ useOpenPLCStore: { getState: jest.fn(), subscribe: jest.fn() } }))
jest.mock('../debug-force-variable', () => ({ forceDebugVariable: jest.fn(), releaseDebugVariable: jest.fn() }))

const PROGRAM_KEY = 'PumpControl:Pump_Fault'
const FORCED_TYPE = 'BOOL'

describe('CES simulator force bridge', () => {
  let child: Window
  let frame: HTMLIFrameElement
  let state: { workspace: Record<string, unknown>; project: Record<string, unknown> }
  const connected = { isConnected: jest.fn(() => true) }

  beforeEach(() => {
    connected.isConnected.mockReturnValue(true)
    frame = document.createElement('iframe')
    frame.src = '/api/v1/projects/p1/editor-sessions/s1/proxy/'
    document.body.appendChild(frame)
    child = frame.contentWindow!
    state = {
      workspace: {
        isDebuggerVisible: true,
        debugVariableIndexes: new Map([[PROGRAM_KEY, 12]]),
        debugForcedVariables: new Map(),
      },
      project: { data: { pous: [{
        name: 'PumpControl', pouType: 'program', interface: {
          variables: [{ name: 'Pump_Fault', type: { definition: 'base-type', value: 'BOOL' } }],
        },
      }] } },
    }
    jest.mocked(useOpenPLCStore.getState).mockImplementation(() => state as unknown as ReturnType<typeof useOpenPLCStore.getState>)
    jest.mocked(useOpenPLCStore.subscribe).mockImplementation(() => () => undefined)
    jest.mocked(forceDebugVariable).mockResolvedValue(true)
    jest.mocked(releaseDebugVariable).mockResolvedValue(true)
  })
  afterEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
    frame.remove()
  })

  function issue(data: Record<string, unknown>, source: MessageEventSource = window, origin = window.location.origin) {
    child.dispatchEvent(new MessageEvent('message', { source, origin, data }))
  }

  it('forces and releases through the native debugger and replies to the CES parent', async () => {
    const post = jest.spyOn(window, 'postMessage').mockImplementation(() => undefined)
    const dispose = installCesProgramForceBridge(connected as unknown as DebuggerPort, child)
    issue({ type: 'ces:simulator-force-command', requestId: 'r1', action: 'force',
      key: PROGRAM_KEY, valueType: FORCED_TYPE, value: 'FALSE' })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(forceDebugVariable).toHaveBeenCalledWith(
      connected, PROGRAM_KEY, 12, new Uint8Array([0]), false, FORCED_TYPE,
    )
    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ces:simulator-force-result', requestId: 'r1', ok: true,
    }), window.location.origin)
    issue({ type: 'ces:simulator-force-command', requestId: 'r2', action: 'release',
      key: PROGRAM_KEY, valueType: FORCED_TYPE })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(releaseDebugVariable).toHaveBeenCalledWith(connected, PROGRAM_KEY, 12)
    dispose()
    post.mockRestore()
  })

  it('rejects commands not sent by the actual same-origin CES parent', async () => {
    const dispose = installCesProgramForceBridge(connected as unknown as DebuggerPort, child)
    issue({ type: 'ces:simulator-force-command', requestId: 'evil', action: 'force',
      key: PROGRAM_KEY, valueType: FORCED_TYPE, value: 'TRUE' }, child, window.location.origin)
    issue({ type: 'ces:simulator-force-command', requestId: 'evil2', action: 'force',
      key: PROGRAM_KEY, valueType: FORCED_TYPE, value: 'TRUE' }, window, 'https://invalid.example')
    await Promise.resolve()
    expect(forceDebugVariable).not.toHaveBeenCalled()
    dispose()
  })

  it('refuses force on disconnected simulator', async () => {
    const post = jest.spyOn(window, 'postMessage').mockImplementation(() => undefined)
    connected.isConnected.mockReturnValueOnce(false)
    const dispose = installCesProgramForceBridge(connected as unknown as DebuggerPort, child)
    connected.isConnected.mockReturnValue(false)
    issue({ type: 'ces:simulator-force-command', requestId: 'r3', action: 'force',
      key: PROGRAM_KEY, valueType: FORCED_TYPE, value: 'TRUE' })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(forceDebugVariable).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ces:simulator-force-result', requestId: 'r3', ok: false,
    }), window.location.origin)
    connected.isConnected.mockReturnValue(true)
    dispose(); post.mockRestore()
  })
})

/** Regression: headless import/compile must load the same typed .stlib
 * interfaces as the GUI before restoring PLCopen block variants.
 */
import { LibraryManagerModule } from '@root/backend/editor/library-manager'
import { openPLCStoreBase } from '@root/frontend/store'
import { bootstrapHeadlessSystemLibraries } from '../bootstrap-libraries'

jest.mock('@root/backend/editor/library-manager', () => ({ LibraryManagerModule: jest.fn() }))
jest.mock('@root/frontend/store', () => ({ openPLCStoreBase: { getState: jest.fn() } }))

const archive = {
  manifest: {
    name: 'standard-test', version: '1.0.0', namespace: 'standard-test',
    isBuiltin: true, functions: [], types: [],
    functionBlocks: [
      { name: 'R_TRIG', inputs: [{ name: 'CLK', type: 'BOOL' }],
        outputs: [{ name: 'Q', type: 'BOOL' }], inouts: [] },
      { name: 'PID', inputs: [{ name: 'AUTO', type: 'BOOL' },
        { name: 'PV', type: 'REAL' }], outputs: [{ name: 'XOUT', type: 'REAL' }], inouts: [] },
    ],
  },
}

const mockLoadAll = jest.fn()
const mockSetSystemLibraries = jest.fn()

describe('headless IEC library bootstrap', () => {
  beforeEach(() => {
    mockLoadAll.mockReset()
    mockSetSystemLibraries.mockReset()
    jest.mocked(LibraryManagerModule).mockImplementation(() =>
      ({ loadAll: mockLoadAll }) as unknown as LibraryManagerModule)
    jest.mocked(openPLCStoreBase.getState).mockReturnValue(
      ({ libraryActions: { setSystemLibraries: mockSetSystemLibraries } }) as unknown as
        ReturnType<typeof openPLCStoreBase.getState>,
    )
  })

  it('installs typed FB interfaces from the strucpp manifest before project hydration', () => {
    mockLoadAll.mockReturnValue([archive])
    expect(bootstrapHeadlessSystemLibraries()).toBe(1)
    const libraries = mockSetSystemLibraries.mock.calls[0][0]
    expect(libraries).toHaveLength(1)
    const rtrig = libraries[0].pous.find((p: { name: string }) => p.name === 'R_TRIG')
    const pid = libraries[0].pous.find((p: { name: string }) => p.name === 'PID')
    expect(rtrig.variables).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Q', class: 'output', type: { definition: 'base-type', value: 'BOOL' } }),
    ]))
    expect(pid.variables).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'AUTO', class: 'input', type: { definition: 'base-type', value: 'BOOL' } }),
    ]))
  })

  it('clears stale library metadata when no archives are installed', () => {
    mockLoadAll.mockReturnValue([])
    expect(bootstrapHeadlessSystemLibraries()).toBe(0)
    expect(mockSetSystemLibraries).toHaveBeenCalledWith([])
  })

  it('fails closed when the library loader fails', () => {
    mockLoadAll.mockImplementation(() => { throw new Error('Failed to read standard IEC library') })
    expect(bootstrapHeadlessSystemLibraries).toThrow('Failed to read standard IEC library')
    expect(mockSetSystemLibraries).not.toHaveBeenCalled()
  })
})

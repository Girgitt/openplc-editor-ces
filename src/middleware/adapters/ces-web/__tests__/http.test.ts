import { resolveCesApiPath } from '../http'

describe('CES web HTTP adapter', () => {
  it('keeps editor API requests relative to the page base for reverse-proxy embedding', () => {
    expect(resolveCesApiPath('/api/document/raw')).toBe('api/document/raw')
    expect(resolveCesApiPath('api/live/snapshot')).toBe('api/live/snapshot')
  })
})

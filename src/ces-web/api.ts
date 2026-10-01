export { cesApi, getCesSessionToken } from '../middleware/adapters/ces-web/http'

export interface CesExternalSymbol {
  id: string
  name: string
  displayName: string
  type: string
  direction: 'input' | 'output' | 'inout' | 'memory'
  group: string
  binding: string
}

export interface CesLiveValue {
  id: string
  value: string
  quality?: string
}

export interface CesLiveSnapshot {
  active: boolean
  revision: number
  values: CesLiveValue[]
}

declare global {
  interface Window {
    __OPENPLC_CES_WEB__?: boolean
  }
}

export function isCesWebEnvironment(): boolean {
  return typeof window !== 'undefined' && window.__OPENPLC_CES_WEB__ === true
}

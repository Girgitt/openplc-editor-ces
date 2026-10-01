import { cesApi } from './http'
import type { ExternalSymbol, ExternalSymbolPort, ExternalSymbolQuery } from '../../shared/ports/external-symbol-port'

interface SymbolResponse {
  symbols: ExternalSymbol[]
}

let cached: ExternalSymbol[] | null = null
let loading: Promise<ExternalSymbol[]> | null = null

async function load(): Promise<ExternalSymbol[]> {
  if (cached) return cached
  if (!loading) {
    loading = cesApi<SymbolResponse>('/api/context/symbols')
      .then((response) => {
        cached = response.symbols
        return cached
      })
      .finally(() => {
        loading = null
      })
  }
  return loading
}

export function invalidateCesExternalSymbols(): void {
  cached = null
}

export function createCesExternalSymbolAdapter(): ExternalSymbolPort {
  return {
    async list(query: ExternalSymbolQuery = {}): Promise<ExternalSymbol[]> {
      const symbols = await load()
      const q = query.q?.trim().toLowerCase() ?? ''
      const type = query.type?.trim().toUpperCase() ?? ''
      return symbols.filter(
        (symbol) =>
          (!q || `${symbol.name} ${symbol.displayName} ${symbol.group} ${symbol.binding}`.toLowerCase().includes(q)) &&
          (!type || symbol.type.toUpperCase() === type) &&
          (!query.direction || symbol.direction === query.direction),
      )
    },
  }
}

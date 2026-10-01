import { useEffect, useState } from 'react'

import type { ExternalSymbol } from '../../middleware/shared/ports/external-symbol-port'
import { useExternalSymbolsPort } from '../../middleware/shared/providers/platform-context'

export function useExternalSymbols(type?: string): ExternalSymbol[] {
  const port = useExternalSymbolsPort()
  const [symbols, setSymbols] = useState<ExternalSymbol[]>([])

  useEffect(() => {
    let cancelled = false
    let retry: number | undefined
    if (!port) {
      setSymbols([])
      return undefined
    }

    const load = async () => {
      try {
        const items = await port.list(type ? { type } : undefined)
        if (cancelled) return
        setSymbols(items)
        // CES normally publishes context before opening the iframe, but tolerate
        // the inverse startup order without creating a permanent polling loop.
        if (items.length === 0) retry = window.setTimeout(() => void load(), 1000)
      } catch {
        if (!cancelled) retry = window.setTimeout(() => void load(), 1000)
      }
    }

    void load()
    return () => {
      cancelled = true
      if (retry !== undefined) window.clearTimeout(retry)
    }
  }, [port, type])

  return symbols
}

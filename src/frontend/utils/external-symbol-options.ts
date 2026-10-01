import type { ExternalSymbol } from '../../middleware/shared/ports/external-symbol-port'

export interface ExternalSymbolOption {
  id: string
  value: string
  label: string
}

export interface ExternalSymbolOptionGroup {
  label: string
  options: ExternalSymbolOption[]
}

export function buildExternalSymbolOptionGroups(
  cellId: string,
  symbols: ExternalSymbol[],
): ExternalSymbolOptionGroup[] {
  const groups = new Map<string, ExternalSymbolOption[]>()
  for (const symbol of symbols) {
    const label = `${symbol.group} · ${symbol.direction}`
    const options = groups.get(label) ?? []
    options.push({
      id: `${cellId}-ces-${symbol.id}`,
      value: symbol.binding,
      label: `${symbol.displayName || symbol.name} : ${symbol.type}`,
    })
    groups.set(label, options)
  }
  return Array.from(groups, ([label, options]) => ({
    label,
    options: options.sort((a, b) => a.label.localeCompare(b.label)),
  })).sort((a, b) => a.label.localeCompare(b.label))
}

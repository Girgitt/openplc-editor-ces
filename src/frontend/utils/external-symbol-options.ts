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

export interface ExternalSymbolLocationPresentation {
  label: string
  title?: string
}

export function externalSymbolLocationPresentation(
  binding: string,
  symbols: ExternalSymbol[],
): ExternalSymbolLocationPresentation {
  const symbol = symbols.find((candidate) => candidate.binding === binding)
  if (!symbol) return { label: binding }

  const displayName = symbol.displayName || symbol.name
  return {
    label: symbol.name || displayName,
    title: `${displayName}\n${symbol.group} · ${symbol.direction} · ${symbol.type}\nBinding: ${symbol.binding}`,
  }
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

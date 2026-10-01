export interface ExternalSymbol {
  id: string
  name: string
  displayName: string
  type: string
  direction: 'input' | 'output' | 'inout' | 'memory'
  group: string
  /** Stable editor-side binding token persisted in PLCVariable.location. */
  binding: string
}

export interface ExternalSymbolQuery {
  q?: string
  type?: string
  direction?: ExternalSymbol['direction']
}

/**
 * Optional engineering-context port. Platforms such as CES can provide a
 * catalog of symbols that are eligible to be bound to PLC variables without
 * exposing the host application's object graph to the editor.
 */
export interface ExternalSymbolPort {
  list(query?: ExternalSymbolQuery): Promise<ExternalSymbol[]>
}

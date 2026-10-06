/**
 * Lossless transient representation for PLCopen SFC bodies.
 *
 * The current OpenPLC Editor exposes an SFC POU type but its graphical SFC
 * editor is still a stub.  CES nevertheless needs an embedded load/save cycle
 * to preserve SFC semantics.  Keep the parsed PLCopen object tree opaque in
 * the editor store and hand it back to the old-editor XML generator unchanged.
 * This value is editor-private/transient; CES persists the canonical M4 graph.
 */
const FORMAT = 'openplc-sfc-plcopen-object-v1'

type OpaqueSfcEnvelope = {
  format: typeof FORMAT
  body: unknown
}

export function encodeOpaqueSfcBody(body: unknown): string {
  return JSON.stringify({ format: FORMAT, body } satisfies OpaqueSfcEnvelope)
}

export function decodeOpaqueSfcBody(value: string): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error(`Invalid opaque SFC payload: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || !('format' in parsed) || !('body' in parsed)) {
    throw new Error('Invalid opaque SFC payload: expected an envelope object')
  }
  const envelope = parsed as { format?: unknown; body?: unknown }
  if (envelope.format !== FORMAT) {
    throw new Error(`Invalid opaque SFC payload format: ${String(envelope.format ?? '(missing)')}`)
  }
  return envelope.body
}

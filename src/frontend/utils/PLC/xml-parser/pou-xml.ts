import type { PLCPou, PLCVariable, PouType, VariableClass } from '../../../../middleware/shared/ports/types'
import { lookupBaseTypeByXmlElement } from '../../iec-types-registry'
import { encodeOpaqueSfcBody } from '../sfc-opaque'
import { parseFbdXml } from './language/fbd-xml'
import { parseLadderXml } from './language/ladder-xml'
import { extractXhtmlText, parseDocumentationXml, parseVariableXml } from './variable-xml'
import { asArray, asRecord, asString } from './xml-node'

const VAR_GROUP_TO_CLASS: Record<string, VariableClass> = {
  inputVars: 'input',
  outputVars: 'output',
  inOutVars: 'inOut',
  externalVars: 'external',
  localVars: 'local',
  tempVars: 'temp',
}

const POU_TYPE_FROM_XML: Record<string, PouType> = {
  program: 'program',
  function: 'function',
  functionBlock: 'function-block',
}

// Reverse of `oldEditorParseInterface` (xml-generator/old-editor/pou-xml.ts).
export function parseInterfaceXml(interfaceXml: unknown): { variables: PLCVariable[]; returnType?: string } {
  const iface = asRecord(interfaceXml)
  const variables: PLCVariable[] = []

  for (const [group, variableClass] of Object.entries(VAR_GROUP_TO_CLASS)) {
    const groupXml = asRecord(iface[group])
    for (const varXml of asArray(groupXml.variable)) {
      variables.push(parseVariableXml(varXml, variableClass))
    }
  }

  if (!iface.returnType) return { variables }

  const returnTypeXml = asRecord(iface.returnType)
  if ('derived' in returnTypeXml) {
    return { variables, returnType: asString(asRecord(returnTypeXml.derived)['@name']) }
  }
  const tag = Object.keys(returnTypeXml)[0]
  return { variables, returnType: tag !== undefined ? (lookupBaseTypeByXmlElement(tag)?.name ?? tag) : undefined }
}

// Reverse of `oldEditorParsePousToXML`. ST/IL/LD/FBD bodies parse into their
// normal editor models. SFC is preserved as an opaque PLCopen object because
// the current SFC editor is still a stub; this keeps load/save lossless without
// pretending SFC is editable. Other unknown dialects remain non-fatal skips.
export function parsePousXml(pouXml: unknown): { pous: PLCPou[]; warnings: string[] } {
  const pous: PLCPou[] = []
  const warnings: string[] = []

  for (const entryRaw of asArray(pouXml)) {
    const entry = asRecord(entryRaw)
    const name = asString(entry['@name'])
    const pouTypeXml = asString(entry['@pouType'])
    const type = POU_TYPE_FROM_XML[pouTypeXml]
    if (!type) {
      warnings.push(`POU "${name}": unrecognized pouType "${pouTypeXml}", skipped`)
      continue
    }

    const body = asRecord(entry.body)
    const { variables, returnType } = parseInterfaceXml(entry.interface)
    const documentation = parseDocumentationXml(entry.documentation)
    const pouInterface = { variables, ...(returnType !== undefined ? { returnType } : {}) }

    if (body.ST !== undefined) {
      pous.push({
        name,
        pouType: type,
        interface: pouInterface,
        body: { language: 'st', value: extractXhtmlText(body.ST) },
        documentation,
      })
      continue
    }
    if (body.IL !== undefined) {
      pous.push({
        name,
        pouType: type,
        interface: pouInterface,
        body: { language: 'il', value: extractXhtmlText(body.IL) },
        documentation,
      })
      continue
    }
    if (body.LD !== undefined) {
      const { body: ldBody, warnings: ldWarnings } = parseLadderXml(name, body.LD, body.addData)
      warnings.push(...ldWarnings)
      pous.push({
        name,
        pouType: type,
        interface: pouInterface,
        body: { language: 'ld', value: ldBody },
        documentation,
      })
      continue
    }
    if (body.FBD !== undefined) {
      const { body: fbdBody, warnings: fbdWarnings } = parseFbdXml(name, body.FBD)
      warnings.push(...fbdWarnings)
      pous.push({
        name,
        pouType: type,
        interface: pouInterface,
        body: { language: 'fbd', value: fbdBody },
        documentation,
      })
      continue
    }
    if (body.SFC !== undefined) {
      pous.push({
        name,
        pouType: type,
        interface: pouInterface,
        body: { language: 'sfc', value: encodeOpaqueSfcBody(body.SFC) },
        documentation,
      })
      continue
    }
    warnings.push(`POU "${name}": no recognized body language found, skipped`)
  }

  return { pous, warnings }
}

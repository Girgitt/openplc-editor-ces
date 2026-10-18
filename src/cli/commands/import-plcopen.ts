/** Import PLCopen TC6 into a newly created native project, preserving graphical bodies.
 *
 * Uses the same XML parser, graph hydration and serializer as the editor GUI;
 * it does not translate LD/FBD into hand-written ST.
 */
import { readFile, mkdir, writeFile, readdir, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { openPLCStoreBase } from '@root/frontend/store'
import { buildAllProjectFileContentsPure } from '@root/frontend/services/save-actions'
import { buildProjectResponseFromPlcopenParse } from '@root/frontend/utils/PLC/build-plcopen-project-response'
import { parsePlcopenXml } from '@root/frontend/utils/PLC/xml-parser'

import type { ParsedArgs } from '../args'
import { stringFlag } from '../args'
import { ErrorCode, ExitCode } from '../exit-codes'
import type { CliResult, Reporter } from '../output'
import { loadProject } from '../project/load'

export async function runImportPlcopen(args: ParsedArgs, reporter: Reporter): Promise<CliResult> {
  const xmlPath = args.positionals[0] ?? stringFlag(args, 'source')
  const projectPath = stringFlag(args, 'project')
  if (!xmlPath || !projectPath) {
    return reporter.failure({ code: ErrorCode.MissingArgument, message:
      'Usage: import-plcopen <source.xml> --project <newly-created-project>' }, ExitCode.Usage)
  }
  try {
    // Load the native project first to initialize board definitions and system FB signatures.
    // The same hydration path is used by a GUI-opened PLCopen project.
    const initial = await loadProject(projectPath)
    if (!initial.success) throw new Error(initial.error)
    const parsed = parsePlcopenXml(await readFile(xmlPath, 'utf-8'))
    if (parsed.warnings.length) throw new Error(`Lossy PLCopen import rejected: ${parsed.warnings.join('; ')}`)
    if (!parsed.projectData.pous.length || !parsed.projectData.pous.some(p => p.pouType === 'program')) {
      throw new Error('PLCopen import requires a PROGRAM POU')
    }
    const data = buildProjectResponseFromPlcopenParse(parsed, projectPath)
    openPLCStoreBase.getState().sharedWorkspaceActions.handleOpenProjectResponse(data)
    const files = buildAllProjectFileContentsPure()
    if (!files['project.json']) throw new Error('Editor serializer emitted no project.json')
    // All paths come from the editor's own serializer; validate before touching disk.
    const entries = Object.entries(files)
    for (const [name] of entries) {
      const normalized = name.replaceAll('\\', '/')
      if (isAbsolute(name) || normalized.startsWith('/') || normalized.split('/').includes('..') ||
          normalized.split('/').includes('.') || !normalized) {
        throw new Error(`Unsafe generated project path: ${name}`)
      }
    }
    // Purge only default POU files from the *freshly created* project. No other
    // project contents are removed. Invoke on a temporary scratch project only.
    for (const category of ['programs', 'functions', 'function-blocks']) {
      const directory = join(projectPath, 'pous', category)
      const old = await readdir(directory).catch(() => [] as string[])
      for (const file of old) {
        const name = `pous/${category}/${file}`
        if (!(name in files) && /\.(?:st|ld|fbd|il|sfc)$/i.test(file)) {
          await unlink(join(directory, file))
        }
      }
    }
    // Index last: compiling against an incomplete project must not report success.
    for (const [name, content] of entries.filter(([name]) => name !== 'project.json')) {
      const destination = join(projectPath, name)
      await mkdir(join(destination, '..'), { recursive: true })
      await writeFile(destination, content, 'utf-8')
    }
    await writeFile(join(projectPath, 'project.json'), files['project.json'], 'utf-8')
    return reporter.success({ projectPath, importedPous: parsed.projectData.pous.map(p => ({
      name: p.name, language: p.body.language, pouType: p.pouType,
    })) }, () => `Imported ${parsed.projectData.pous.length} PLCopen POUs`)
  } catch (error) {
    return reporter.failure({ code: ErrorCode.InvalidArgument,
      message: error instanceof Error ? error.message : String(error) }, ExitCode.Usage)
  }
}

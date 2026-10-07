#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, promises as fs, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 43821
const MAX_JSON_BYTES = 16 * 1024 * 1024
const MAX_SYMBOLS = 100_000
const MAX_LIVE_VALUES = 100_000
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_BUNDLED_LIBRARY_DIR = resolve(SCRIPT_DIR, '..', 'node_modules', 'strucpp', 'libs')
const EDITOR_ROOT = resolve(SCRIPT_DIR, '..')
const SIMULATOR_TARGET = 'OpenPLC Simulator'
const DEFAULT_SIMULATOR_BUILD_TIMEOUT_MS = 120_000
// Renderer project routing treats every non-absolute path as an Autonomy Edge
// project ID.  Web sessions therefore use an absolute *virtual* local path so
// open/save operations stay on the CES REST bridge rather than the cloud port.
const VIRTUAL_PROJECT_PATH = '/ces-session'
const PROJECT_DIRECTORIES = [
  'devices',
  'pous/functions',
  'pous/function-blocks',
  'pous/programs',
  'datatypes',
]

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}


function electronExecutable(editorRoot = EDITOR_ROOT) {
  const packageRoot = join(editorRoot, 'node_modules', 'electron')
  const pathFile = join(packageRoot, 'path.txt')
  if (!existsSync(pathFile)) return null

  const executableName = readFileSync(pathFile, 'utf8').trim()
  if (!executableName) return null
  const distRoot = process.env.ELECTRON_OVERRIDE_DIST_PATH || join(packageRoot, 'dist')
  const executable = join(distRoot, executableName)
  return existsSync(executable) ? executable : null
}

function runProcess(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const timeoutMs = Number(options.timeoutMs ?? 0)
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: process.platform === 'win32',
      // Give the compiler its own process group on POSIX so a timeout can stop
      // Electron and any compiler/toolchain children it spawned.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer = null

    const finish = (callback) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      callback()
    }
    const terminate = () => {
      if (child.pid === undefined) return
      try {
        if (process.platform === 'win32') child.kill('SIGTERM')
        else process.kill(-child.pid, 'SIGTERM')
      } catch {
        try { child.kill('SIGTERM') } catch { /* already exited */ }
      }
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => finish(() => rejectRun(error)))
    child.once('close', (code, signal) => finish(() => resolveRun({ code, signal, stdout, stderr })))

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        terminate()
        finish(() => rejectRun(new Error(`OpenPLC simulator build timed out after ${timeoutMs} ms`)))
      }, timeoutMs)
    }
  })
}

const IEC_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const PROGRAM_DECLARATION_RE = /^([ \t]*PROGRAM[ \t]+)([^\s:]+)(?=[ \t\r\n]|$)/im

function simulatorProgramIdentity(programFile) {
  const programPath = String(programFile?.relativePath ?? '').replaceAll('\\', '/')
  const fileStem = basename(programPath, extname(programPath))
  const content = String(programFile?.content ?? '')
  const declaration = content.match(PROGRAM_DECLARATION_RE)
  const declaredName = declaration?.[2] || fileStem
  if (!declaredName) return null

  // CES/display filenames may contain '-' and other characters that are valid
  // project identifiers but illegal in an IEC 61131-3 identifier. Keep the
  // canonical/editor document untouched and alias only the transient simulator
  // copy. Prefixing the sanitized value avoids keywords and leading digits.
  const simulatorName = IEC_IDENTIFIER_RE.test(declaredName)
    ? declaredName
    : `CES_SIM_${declaredName.replace(/[^A-Za-z0-9_]/g, '_')}`
  const simulatorContent =
    simulatorName === declaredName || !declaration
      ? content
      : content.replace(PROGRAM_DECLARATION_RE, `$1${simulatorName}`)

  return { declaredName, simulatorName, simulatorContent }
}

function withSimulatorDefaultSchedule(document) {
  if (!document || document.format !== 'openplc-project-files') return document

  let project
  try {
    project = JSON.parse(document.files?.projectJson ?? '')
  } catch {
    // Leave malformed project.json untouched so the normal compiler/parser path
    // reports the real project error rather than hiding it behind synthesis.
    return document
  }

  const resource = project?.data?.configuration?.resource
  if (!resource || !Array.isArray(resource.tasks) || !Array.isArray(resource.instances)) return document
  if (resource.tasks.length > 0 || resource.instances.length > 0) return document

  // CES's canonical PLCopen application currently carries the POU graph but no
  // runtime task/instance schedule. That is legitimate for editing, but STruC++
  // emits a broken zero-task Configuration_CONFIG0 (it takes &tasks_storage[0]
  // without declaring tasks_storage). Give the *transient simulator copy* the
  // same default cyclic schedule a freshly-created OpenPLC PLC project gets.
  // Never write this back through canonical-save: runtime deployment scheduling
  // remains a CES concern, while editor simulation only needs one root program
  // to execute.
  const programFile = (document.files?.pouFiles ?? []).find((item) => {
    const rel = String(item?.relativePath ?? '').replaceAll('\\', '/')
    return rel.startsWith('pous/programs/') && extname(rel) !== ''
  })
  if (!programFile) return document

  const identity = simulatorProgramIdentity(programFile)
  if (!identity) return document

  resource.tasks = [{ name: 'task0', triggering: 'Cyclic', interval: 'T#20ms', priority: 1 }]
  resource.instances = [{ name: 'instance0', program: identity.simulatorName, task: 'task0' }]

  const pouFiles = (document.files?.pouFiles ?? []).map((item) =>
    item === programFile && identity.simulatorContent !== String(item?.content ?? '')
      ? { ...item, content: identity.simulatorContent }
      : item,
  )

  return {
    ...document,
    files: {
      ...document.files,
      projectJson: `${JSON.stringify(project, null, 2)}\n`,
      pouFiles,
    },
  }
}

export async function buildSimulatorProject(document, options = {}) {
  const editorRoot = resolve(options.editorRoot ?? EDITOR_ROOT)
  const electron = options.electronExecutable ?? electronExecutable(editorRoot)
  // Use the dedicated development CLI bundle. Its webpack config deliberately
  // bakes NODE_ENV=development and emits at the repository root so compiler
  // paths resolve to <repo>/resources and <repo>/node_modules/strucpp. Running
  // the production main bundle under the npm Electron runtime instead points
  // CompilerModule at Electron's resourcesPath and fails on first-run files /
  // arduino-cli before the simulator compiler can start.
  const cliBundle = join(editorRoot, 'openplc-cli.dev.js')
  if (!electron || !existsSync(electron)) {
    throw new HttpError(
      503,
      'OpenPLC Electron runtime is unavailable; run npm run build:ces-web to repair/install it',
    )
  }
  if (!existsSync(cliBundle)) throw new HttpError(503, 'OpenPLC development CLI bundle is missing; run npm run build:ces-web')

  const root = await fs.mkdtemp(join(tmpdir(), 'openplc-ces-simulator-'))
  try {
    await writeProjectDirectory(root, withSimulatorDefaultSchedule(document))
    const result = await runProcess(
      electron,
      [cliBundle, '--cli', 'compile', root, '--target', SIMULATOR_TARGET, '--json'],
      { cwd: editorRoot, timeoutMs: options.simulatorBuildTimeoutMs ?? DEFAULT_SIMULATOR_BUILD_TIMEOUT_MS },
    )
    let payload = null
    try { payload = JSON.parse(result.stdout.trim() || '{}') } catch {
      throw new Error(`OpenPLC CLI returned invalid JSON: ${result.stdout.slice(0, 500)}`)
    }
    if (result.code !== 0 || payload?.ok !== true) {
      // CLI progress/diagnostics are written to stderr even in JSON mode,
      // while stdout carries only the final result document.  The final JSON
      // error is often the intentionally generic "Stopping compilation
      // process."; preferring it used to hide the useful compiler diagnostic
      // that appeared one line earlier. Preserve the complete stderr report and
      // append the structured message only when it adds information.
      const stderrLines = result.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      const structuredMessage = typeof payload?.error?.message === 'string' ? payload.error.message.trim() : ''
      if (structuredMessage && !stderrLines.includes(structuredMessage)) stderrLines.push(structuredMessage)
      const message = stderrLines.join('\n') || structuredMessage || `OpenPLC CLI exited with code ${result.code}`
      throw new Error(message)
    }
    const firmwarePath = typeof payload.firmwarePath === 'string' ? payload.firmwarePath : ''
    if (!firmwarePath) throw new Error('OpenPLC CLI did not return a simulator firmware path')
    const resolvedFirmwarePath = isAbsolute(firmwarePath) ? firmwarePath : resolve(root, firmwarePath)
    const debugMapPath = join(root, 'build', SIMULATOR_TARGET, 'src', 'debug-map.json')
    const [firmwareHex, debugMap] = await Promise.all([
      fs.readFile(resolvedFirmwarePath, 'utf8'),
      fs.readFile(debugMapPath, 'utf8'),
    ])
    const parsedDebugMap = JSON.parse(debugMap)
    const md5 = typeof parsedDebugMap?.md5 === 'string' ? parsedDebugMap.md5 : ''
    if (!md5) throw new Error('debug-map.json does not contain a program md5')
    return {
      success: true,
      firmwareHex,
      debugMap,
      md5,
      logs: result.stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function badRequest(res, message) {
  json(res, 400, { error: message })
}

function normalizeRelativePath(value, label = 'relativePath') {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`)
  const candidate = value.replaceAll('\\', '/').replace(/^\.\/+/, '')
  if (candidate.startsWith('/') || candidate.split('/').includes('..')) {
    throw new Error(`${label} must stay inside the OpenPLC project`)
  }
  return candidate
}

function normalizeProjectId(value) {
  if (typeof value !== 'string' || !PROJECT_ID_RE.test(value) || value === '.' || value === '..') {
    throw new HttpError(400, 'projectId must be a single safe directory name using letters, digits, dot, underscore or dash')
  }
  return value
}

function parseBoolean(value, label) {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  throw new Error(`${label} must be true or false`)
}

async function readJson(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > MAX_JSON_BYTES) throw new Error(`request body exceeds ${MAX_JSON_BYTES} bytes`)
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function normalizeFilesDocument(value, fallbackId = 'ces-session') {
  if (!value || typeof value !== 'object') throw new Error('document must be an object')
  const files = value.files ?? value
  if (!files || typeof files !== 'object') throw new Error('files payload is required')
  if (typeof files.projectJson !== 'string') throw new Error('files.projectJson must be a string')

  const arrayOfFiles = (name) => {
    const items = files[name] ?? []
    if (!Array.isArray(items)) throw new Error(`files.${name} must be an array`)
    return items.map((item) => {
      if (!item || typeof item.relativePath !== 'string' || typeof item.content !== 'string') {
        throw new Error(`files.${name} entries require relativePath and content strings`)
      }
      return { relativePath: normalizeRelativePath(item.relativePath, `files.${name}.relativePath`), content: item.content }
    })
  }

  return {
    format: 'openplc-project-files',
    documentId: String(value.documentId ?? fallbackId),
    files: {
      projectPath: String(files.projectPath || fallbackId),
      projectJson: files.projectJson,
      deviceConfig: typeof files.deviceConfig === 'string' ? files.deviceConfig : '{}',
      pinMapping: typeof files.pinMapping === 'string' ? files.pinMapping : '{}',
      libraryManifest: typeof files.libraryManifest === 'string' ? files.libraryManifest : '',
      pouFiles: arrayOfFiles('pouFiles'),
      serverFiles: arrayOfFiles('serverFiles'),
      remoteDeviceFiles: arrayOfFiles('remoteDeviceFiles'),
      dataTypeFiles: arrayOfFiles('dataTypeFiles'),
      deletions: Array.isArray(files.deletions) ? files.deletions.map((item) => normalizeRelativePath(item, 'files.deletions')) : [],
    },
  }
}

function normalizeDocument(value) {
  if (!value || typeof value !== 'object') throw new Error('document payload is required')
  if (value.format === 'plcopen-xml') {
    if (typeof value.content !== 'string' || value.content.trim() === '') {
      throw new Error('plcopen-xml content must be a non-empty string')
    }
    return {
      format: 'plcopen-xml',
      documentId: String(value.documentId ?? 'ces-session'),
      content: value.content,
    }
  }
  if (value.format === 'openplc-project-files' || value.files || value.projectJson) {
    return normalizeFilesDocument(value)
  }
  throw new Error('format must be plcopen-xml or openplc-project-files')
}

function normalizeSymbol(value) {
  if (!value || typeof value !== 'object') throw new Error('symbol entries must be objects')
  for (const field of ['id', 'name', 'type', 'direction', 'binding']) {
    if (typeof value[field] !== 'string' || value[field].trim() === '') throw new Error(`symbol.${field} is required`)
  }
  if (!['input', 'output', 'inout', 'memory'].includes(value.direction)) {
    throw new Error(`unsupported symbol direction: ${value.direction}`)
  }
  return {
    id: value.id,
    name: value.name,
    displayName: typeof value.displayName === 'string' ? value.displayName : value.name,
    type: value.type.toUpperCase(),
    direction: value.direction,
    group: typeof value.group === 'string' ? value.group : 'CES signals',
    binding: value.binding,
  }
}

function normalizeSymbols(value) {
  const items = Array.isArray(value) ? value : value?.symbols
  if (!Array.isArray(items)) throw new Error('symbols must be an array')
  if (items.length > MAX_SYMBOLS) throw new Error(`symbol count exceeds ${MAX_SYMBOLS}`)
  const ids = new Set()
  const bindings = new Set()
  return items.map((item) => {
    const symbol = normalizeSymbol(item)
    if (ids.has(symbol.id)) throw new Error(`duplicate symbol id: ${symbol.id}`)
    if (bindings.has(symbol.binding)) throw new Error(`duplicate symbol binding: ${symbol.binding}`)
    ids.add(symbol.id)
    bindings.add(symbol.binding)
    return symbol
  })
}

function normalizeLiveSnapshot(value, knownSymbolIds) {
  if (!value || typeof value !== 'object') throw new Error('snapshot payload is required')
  const values = Array.isArray(value.values) ? value.values : []
  if (values.length > MAX_LIVE_VALUES) throw new Error(`live value count exceeds ${MAX_LIVE_VALUES}`)
  return {
    active: true,
    revision: Number.isFinite(value.revision) ? Number(value.revision) : Date.now(),
    values: values.map((entry) => {
      if (!entry || typeof entry.id !== 'string' || !knownSymbolIds.has(entry.id)) {
        throw new Error(`live value references an unknown symbol id: ${entry?.id ?? '(missing)'}`)
      }
      return {
        id: entry.id,
        value: String(entry.value),
        quality: typeof entry.quality === 'string' ? entry.quality : 'good',
      }
    }),
  }
}

function normalizeSimulatorLiveSnapshot(value, nextRevision) {
  if (!value || typeof value !== 'object') throw new Error('simulator snapshot payload is required')
  const values = Array.isArray(value.values) ? value.values : []
  if (values.length > MAX_LIVE_VALUES) throw new Error(`simulator live value count exceeds ${MAX_LIVE_VALUES}`)
  const seen = new Set()
  return {
    active: true,
    revision: nextRevision,
    values: values.map((entry) => {
      if (!entry || typeof entry.key !== 'string' || entry.key.trim() === '') {
        throw new Error('simulator live value key is required')
      }
      if (seen.has(entry.key)) throw new Error(`duplicate simulator live key: ${entry.key}`)
      seen.add(entry.key)
      return {
        key: entry.key,
        value: String(entry.value ?? ''),
      }
    }),
  }
}

async function readBundledLibraries(directory) {
  if (!existsSync(directory)) return { archives: [], installed: [] }
  const archives = []
  const installed = []
  const entries = (await fs.readdir(directory)).filter((item) => item.endsWith('.stlib')).sort()
  for (const file of entries) {
    try {
      const archive = JSON.parse(await fs.readFile(join(directory, file), 'utf8'))
      const manifest = archive?.manifest
      if (!manifest || typeof manifest !== 'object' || typeof manifest.name !== 'string') continue
      archives.push(archive)
      installed.push({
        name: manifest.name,
        version: typeof manifest.version === 'string' ? manifest.version : '',
        bundled: true,
        installedAt: '',
        origin: 'bundled',
        ...(typeof manifest.displayName === 'string' && manifest.displayName ? { displayName: manifest.displayName } : {}),
        ...(typeof manifest.description === 'string' && manifest.description ? { description: manifest.description } : {}),
      })
    } catch {
      // Match the desktop LibraryManager: one malformed bundled archive must
      // not make the editor fail to start or hide the remaining libraries.
    }
  }
  return { archives, installed }
}

async function requireExistingProjectRoot(projectRoot) {
  if (!projectRoot) return null
  const root = resolve(projectRoot)
  let stat
  try {
    stat = await fs.stat(root)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`project root does not exist: ${root}`)
    throw error
  }
  if (!stat.isDirectory()) throw new Error(`project root is not a directory: ${root}`)
  return root
}

async function pathState(path) {
  try {
    const stat = await fs.stat(path)
    if (!stat.isDirectory()) return 'not-directory'
    const entries = await fs.readdir(path)
    return entries.length === 0 ? 'empty-directory' : 'non-empty-directory'
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing'
    throw error
  }
}

function defaultProjectJson(name) {
  // Mirrors the current default plc-project authored by
  // backend/shared/project/create-project-files.ts. Keep the server-side
  // standalone initializer intentionally small and covered by the S1H
  // contract test so drift is visible when the canonical defaults change.
  return {
    meta: { name, type: 'plc-project' },
    data: {
      pous: [],
      dataTypes: [],
      libraries: [],
      configuration: {
        resource: {
          tasks: [{ name: 'task0', triggering: 'Cyclic', interval: 'T#20ms', priority: 1 }],
          instances: [{ name: 'instance0', program: 'main', task: 'task0' }],
          globalVariables: [],
        },
      },
    },
  }
}

export async function initializeProjectDirectory(projectPath, projectName = basename(resolve(projectPath))) {
  const root = resolve(projectPath)
  await fs.mkdir(root, { recursive: true })
  for (const relativeDir of PROJECT_DIRECTORIES) await fs.mkdir(join(root, relativeDir), { recursive: true })
  await fs.writeFile(join(root, 'project.json'), `${JSON.stringify(defaultProjectJson(projectName), null, 2)}\n`, 'utf8')
  await fs.writeFile(join(root, 'devices/configuration.json'), `${JSON.stringify({
    deviceBoard: 'OpenPLC Simulator',
    communicationPort: '',
    selectedPlatformOptions: {},
  }, null, 2)}\n`, 'utf8')
  await fs.writeFile(join(root, 'devices/pin-mapping.json'), '{}\n', 'utf8')
  await fs.writeFile(join(root, 'pous/programs/main.st'), 'PROGRAM main\n\n\nEND_PROGRAM\n', 'utf8')
  return root
}

async function ensureOpenPlcProject(projectPath, initializeNewProject, projectName) {
  const root = resolve(projectPath)
  const state = await pathState(root)

  if (state === 'missing') {
    if (!initializeNewProject) throw new HttpError(404, `OpenPLC project does not exist: ${root}`)
    await initializeProjectDirectory(root, projectName)
    return root
  }
  if (state === 'not-directory') throw new HttpError(409, `OpenPLC project path is not a directory: ${root}`)
  if (existsSync(join(root, 'project.json'))) return root
  if (state === 'empty-directory') {
    await initializeProjectDirectory(root, projectName)
    return root
  }
  throw new HttpError(409, `${root} is non-empty but is not an OpenPLC project (project.json missing)`)
}

function resolveProjectUnderRoot(projectRoot, projectId) {
  if (!projectRoot) throw new HttpError(409, 'project_id cannot be used because no --project-root is configured')
  const id = normalizeProjectId(projectId)
  const root = resolve(projectRoot)
  const projectPath = resolve(root, id)
  if (dirname(projectPath) !== root) throw new HttpError(400, 'projectId must resolve directly below the configured project root')
  return { id, projectPath }
}

export async function readProjectDirectory(projectPath) {
  const root = resolve(projectPath)
  const projectJsonPath = join(root, 'project.json')
  if (!existsSync(projectJsonPath)) throw new Error(`${root} is not an OpenPLC project (project.json missing)`)

  const readText = async (relativePath, fallback = '') => {
    try {
      return await fs.readFile(join(root, relativePath), 'utf8')
    } catch {
      return fallback
    }
  }
  const collect = async (relativeDir, extensions = null) => {
    const base = join(root, relativeDir)
    const out = []
    const walk = async (dir) => {
      let entries = []
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const absolute = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(absolute)
        } else if (entry.isFile()) {
          if (extensions && !extensions.includes(extname(entry.name))) continue
          const relativePath = absolute.slice(root.length + 1).split(sep).join('/')
          out.push({ relativePath, content: await fs.readFile(absolute, 'utf8') })
        }
      }
    }
    await walk(base)
    return out
  }

  const pouFiles = []
  for (const dir of ['pous/functions', 'pous/function-blocks', 'pous/programs']) {
    pouFiles.push(...(await collect(dir, ['.st', '.il', '.ld', '.fbd', '.py', '.cpp', '.json'])))
  }
  return normalizeFilesDocument({
    documentId: root,
    files: {
      projectPath: VIRTUAL_PROJECT_PATH,
      projectJson: await readText('project.json', '{}'),
      deviceConfig: await readText('devices/configuration.json', '{}'),
      pinMapping: await readText('devices/pin-mapping.json', '{}'),
      libraryManifest: await readText('library.json', ''),
      pouFiles,
      serverFiles: await collect('devices/servers'),
      remoteDeviceFiles: await collect('devices/remote'),
      dataTypeFiles: await collect('datatypes', ['.dt']),
      deletions: [],
    },
  })
}

async function writeTextInsideProject(root, relativePath, content) {
  const rel = normalizeRelativePath(relativePath)
  const target = resolve(root, rel)
  if (!(target === root || target.startsWith(`${root}${sep}`))) throw new Error('file path escaped the OpenPLC project')
  await fs.mkdir(dirname(target), { recursive: true })
  await fs.writeFile(target, content, 'utf8')
}

async function writeProjectDirectory(projectPath, document) {
  if (!document || document.format !== 'openplc-project-files') {
    throw new HttpError(409, 'filesystem-backed sessions require an OpenPLC project-files document')
  }
  const root = resolve(projectPath)
  const files = document.files
  await writeTextInsideProject(root, 'project.json', files.projectJson)
  await writeTextInsideProject(root, 'devices/configuration.json', files.deviceConfig ?? '{}')
  await writeTextInsideProject(root, 'devices/pin-mapping.json', files.pinMapping ?? '{}')
  if (files.libraryManifest) await writeTextInsideProject(root, 'library.json', files.libraryManifest)

  for (const bucket of ['pouFiles', 'serverFiles', 'remoteDeviceFiles', 'dataTypeFiles']) {
    for (const item of files[bucket] ?? []) await writeTextInsideProject(root, item.relativePath, item.content)
  }
  for (const relativePath of files.deletions ?? []) {
    const rel = normalizeRelativePath(relativePath, 'files.deletions')
    const target = resolve(root, rel)
    if (!(target === root || target.startsWith(`${root}${sep}`))) throw new Error('deletion path escaped the OpenPLC project')
    await fs.rm(target, { recursive: true, force: true })
  }
}

function documentAsRawFiles(document) {
  if (!document) return null
  if (document.format === 'plcopen-xml') {
    return {
      success: true,
      data: {
        projectPath: VIRTUAL_PROJECT_PATH,
        projectJson: '',
        deviceConfig: '{}',
        pinMapping: '{}',
        libraryManifest: '',
        pouFiles: [],
        serverFiles: [],
        remoteDeviceFiles: [],
        dataTypeFiles: [],
        canEdit: true,
        pendingPlcopenSource: document.content,
      },
    }
  }
  const f = document.files
  return {
    success: true,
    data: {
      projectPath: VIRTUAL_PROJECT_PATH,
      projectJson: f.projectJson,
      deviceConfig: f.deviceConfig ?? '{}',
      pinMapping: f.pinMapping ?? '{}',
      libraryManifest: f.libraryManifest ?? '',
      pouFiles: f.pouFiles ?? [],
      serverFiles: f.serverFiles ?? [],
      remoteDeviceFiles: f.remoteDeviceFiles ?? [],
      dataTypeFiles: f.dataTypeFiles ?? [],
      canEdit: true,
    },
  }
}

function parseArgs(argv) {
  const result = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    staticDir: 'release/app/dist/ces-web',
    project: null,
    projectRoot: null,
    initializeNewProject: false,
    token: '',
    debug: false,
    simulatorBuildTimeoutMs: DEFAULT_SIMULATOR_BUILD_TIMEOUT_MS,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    const next = argv[i + 1]
    if (key === '--host' && next) { result.host = next; i += 1 }
    else if (key === '--port' && next) { result.port = Number(next); i += 1 }
    else if (key === '--static' && next) { result.staticDir = next; i += 1 }
    else if (key === '--project' && next) { result.project = next; i += 1 }
    else if (key === '--project-root' && next) { result.projectRoot = next; i += 1 }
    else if (key === '--session-token' && next) { result.token = next; i += 1 }
    else if (key === '--debug') result.debug = true
    else if (key === '--simulator-build-timeout-ms' && next) { result.simulatorBuildTimeoutMs = Number(next); i += 1 }
    else if (key.startsWith('--initialize-new-project=')) {
      result.initializeNewProject = parseBoolean(key.slice(key.indexOf('=') + 1), '--initialize-new-project')
    } else if (key === '--initialize-new-project') {
      if (next === 'true' || next === 'false') { result.initializeNewProject = parseBoolean(next, key); i += 1 }
      else result.initializeNewProject = true
    }
  }
  return result
}

export async function createCesEditorServer(options = {}) {
  const host = options.host ?? DEFAULT_HOST
  const port = options.port ?? DEFAULT_PORT
  const staticRoot = resolve(options.staticDir ?? 'release/app/dist/ces-web')
  const token = options.token ?? ''
  const debug = options.debug === true
  const bundledLibraryDir = resolve(options.bundledLibraryDir ?? DEFAULT_BUNDLED_LIBRARY_DIR)
  const simulationBuilder = options.simulationBuilder ?? ((document) => buildSimulatorProject(document, options))
  const trace = (event, detail = undefined) => {
    if (!debug) return
    const suffix = detail === undefined ? '' : ` ${JSON.stringify(detail)}`
    console.log(`[ces-web][debug] ${event}${suffix}`)
  }
  const initializeNewProject = parseBoolean(options.initializeNewProject ?? false, 'initializeNewProject')
  const projectRoot = await requireExistingProjectRoot(options.projectRoot ?? null)
  let initialDocument = null
  let initialPersistence = { kind: 'rest' }
  if (options.project) {
    const root = await ensureOpenPlcProject(options.project, initializeNewProject, basename(resolve(options.project)))
    initialDocument = await readProjectDirectory(root)
    initialPersistence = { kind: 'filesystem', root, projectId: null }
  }

  const state = {
    document: initialDocument,
    documentRevision: 0,
    persistence: initialPersistence,
    symbols: [],
    live: { active: false, revision: 0, values: [] },
    simulatorProject: null,
    simulatorBuildRevision: 0,
    simulatorLive: { active: false, revision: 0, values: [] },
  }

  const authorized = (req) => !token || req.headers['x-ces-editor-token'] === token || req.headers.authorization === `Bearer ${token}`
  const requireAuth = (req, res) => {
    if (authorized(req)) return true
    json(res, 401, { error: 'invalid or missing CES editor session token' })
    return false
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const path = url.pathname
      trace('request', {
        method: req.method ?? '',
        path,
        projectId: url.searchParams.get('project_id') ?? undefined,
      })

      if (req.method === 'GET' && path === '/api/health') {
        return json(res, 200, {
          status: 'ok',
          service: 'openplc-editor-ces',
          documentLoaded: state.document !== null,
          documentRevision: state.documentRevision,
          persistence: state.persistence.kind,
          simulatorProjectReady: state.simulatorProject !== null,
          simulatorBuildRevision: state.simulatorBuildRevision,
          simulatorLiveActive: state.simulatorLive.active,
          simulatorLiveRevision: state.simulatorLive.revision,
        })
      }

      if (path.startsWith('/api/')) {
        const ok = authorized(req)
        trace('api-auth', { method: req.method ?? '', path, authorized: ok })
        if (!ok) {
          requireAuth(req, res)
          return
        }
      }

      if (req.method === 'POST' && path === '/api/project/open') {
        const body = await readJson(req)
        trace('project-open requested', { projectId: body.projectId ?? null })
        const { id, projectPath } = resolveProjectUnderRoot(projectRoot, body.projectId)
        const beforeState = await pathState(projectPath)
        trace('project-open resolved', {
          projectId: id,
          projectPath,
          beforeState,
          initializeNewProject,
        })
        const root = await ensureOpenPlcProject(projectPath, initializeNewProject, id)
        state.document = await readProjectDirectory(root)
        state.persistence = { kind: 'filesystem', root, projectId: id }
        state.documentRevision += 1
        trace('project-open loaded', {
          projectId: id,
          persistence: state.persistence.kind,
          revision: state.documentRevision,
          rendererProjectPath: state.document?.files?.projectPath ?? null,
          pouFiles: state.document?.files?.pouFiles?.length ?? 0,
        })
        return json(res, 200, { success: true, projectId: id, revision: state.documentRevision })
      }

      if (req.method === 'POST' && path === '/api/document/load') {
        state.document = normalizeDocument(await readJson(req))
        state.persistence = { kind: 'rest' }
        state.simulatorProject = null
        state.simulatorLive = { active: false, revision: state.simulatorLive.revision + 1, values: [] }
        state.documentRevision += 1
        return json(res, 200, { success: true, revision: state.documentRevision, document: state.document })
      }
      if (req.method === 'GET' && path === '/api/document') {
        if (!state.document) return json(res, 404, { error: 'no document loaded' })
        return json(res, 200, { revision: state.documentRevision, document: state.document })
      }
      if (req.method === 'GET' && path === '/api/document/raw') {
        const raw = documentAsRawFiles(state.document)
        trace('document-raw', {
          loaded: raw !== null,
          persistence: state.persistence.kind,
          revision: state.documentRevision,
          rendererProjectPath: raw?.data?.projectPath ?? null,
          pouFiles: raw?.data?.pouFiles?.length ?? 0,
        })
        if (!raw) return json(res, 404, { success: false, error: { title: 'No document', description: 'No document loaded' } })
        return json(res, 200, raw)
      }
      if (req.method === 'POST' && path === '/api/document/save') {
        const body = await readJson(req)
        state.document = normalizeFilesDocument({ documentId: state.document?.documentId ?? 'ces-session', files: body })
        if (state.persistence.kind === 'filesystem') await writeProjectDirectory(state.persistence.root, state.document)
        state.documentRevision += 1
        return json(res, 200, { success: true, revision: state.documentRevision, document: state.document })
      }
      if (req.method === 'POST' && path === '/api/document/save-file') {
        const body = await readJson(req)
        if (!state.document || state.document.format !== 'openplc-project-files') {
          return json(res, 409, { success: false, error: 'Save the full project once before saving individual files.' })
        }
        if (typeof body.filePath !== 'string' || typeof body.content !== 'string') return badRequest(res, 'filePath and content are required')
        const rel = normalizeRelativePath(body.filePath.replace(/^\/?ces-session\/?/, ''), 'filePath')
        const buckets = ['pouFiles', 'serverFiles', 'remoteDeviceFiles', 'dataTypeFiles']
        let updated = false
        for (const bucket of buckets) {
          const item = state.document.files[bucket].find((entry) => entry.relativePath === rel)
          if (item) { item.content = body.content; updated = true; break }
        }
        if (!updated) state.document.files.pouFiles.push({ relativePath: rel, content: body.content })
        if (state.persistence.kind === 'filesystem') await writeTextInsideProject(state.persistence.root, rel, body.content)
        state.documentRevision += 1
        return json(res, 200, { success: true, revision: state.documentRevision })
      }


      if (req.method === 'POST' && path === '/api/simulator/project') {
        state.simulatorProject = normalizeFilesDocument({
          documentId: state.document?.documentId ?? 'ces-simulator',
          files: await readJson(req),
        })
        state.simulatorLive = { active: false, revision: state.simulatorLive.revision + 1, values: [] }
        return json(res, 200, { success: true, pouFiles: state.simulatorProject.files.pouFiles.length })
      }
      if (req.method === 'POST' && path === '/api/simulator/build') {
        if (!state.simulatorProject) {
          return json(res, 409, { success: false, error: 'Save the project before building the simulator.' })
        }
        try {
          const result = await simulationBuilder(state.simulatorProject)
          state.simulatorBuildRevision += 1
          return json(res, 200, { ...result, revision: state.simulatorBuildRevision })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return json(res, error instanceof HttpError ? error.status : 422, { success: false, error: message })
        }
      }

      if (req.method === 'POST' && path === '/api/simulator/live') {
        state.simulatorLive = normalizeSimulatorLiveSnapshot(
          await readJson(req),
          state.simulatorLive.revision + 1,
        )
        return json(res, 200, {
          success: true,
          revision: state.simulatorLive.revision,
          count: state.simulatorLive.values.length,
        })
      }
      if (req.method === 'GET' && path === '/api/simulator/live') {
        return json(res, 200, state.simulatorLive)
      }
      if (req.method === 'POST' && path === '/api/simulator/live/clear') {
        state.simulatorLive = { active: false, revision: state.simulatorLive.revision + 1, values: [] }
        return json(res, 200, { success: true, revision: state.simulatorLive.revision })
      }

      if (req.method === 'GET' && path === '/api/context/libraries') {
        return json(res, 200, await readBundledLibraries(bundledLibraryDir))
      }

      if ((req.method === 'PUT' || req.method === 'POST') && path === '/api/context/symbols') {
        state.symbols = normalizeSymbols(await readJson(req))
        return json(res, 200, { success: true, count: state.symbols.length })
      }
      if (req.method === 'GET' && path === '/api/context/symbols') {
        const q = (url.searchParams.get('q') ?? '').toLowerCase()
        const type = (url.searchParams.get('type') ?? '').toUpperCase()
        const direction = url.searchParams.get('direction') ?? ''
        const symbols = state.symbols.filter((symbol) =>
          (!q || `${symbol.name} ${symbol.displayName} ${symbol.group} ${symbol.binding}`.toLowerCase().includes(q)) &&
          (!type || symbol.type === type) &&
          (!direction || symbol.direction === direction),
        )
        return json(res, 200, { symbols })
      }

      if (req.method === 'POST' && path === '/api/live/snapshot') {
        state.live = normalizeLiveSnapshot(await readJson(req), new Set(state.symbols.map((s) => s.id)))
        return json(res, 200, { success: true, revision: state.live.revision, count: state.live.values.length })
      }
      if (req.method === 'GET' && path === '/api/live/snapshot') return json(res, 200, state.live)
      if (req.method === 'POST' && path === '/api/live/clear') {
        state.live = { active: false, revision: state.live.revision + 1, values: [] }
        return json(res, 200, { success: true, revision: state.live.revision })
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' })

      let relative = decodeURIComponent(path === '/' ? '/index.html' : path)
      relative = normalize(relative).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^[/\\]+/, '')
      let filePath = resolve(staticRoot, relative)
      if (!(filePath === staticRoot || filePath.startsWith(`${staticRoot}${sep}`))) return json(res, 403, { error: 'invalid path' })
      if (!existsSync(filePath)) filePath = join(staticRoot, 'index.html')
      if (!existsSync(filePath)) return json(res, 503, { error: `CES web bundle not found under ${staticRoot}; run npm run build:ces-web` })
      const stat = await fs.stat(filePath)
      if (!stat.isFile()) return json(res, 404, { error: 'not found' })
      res.writeHead(200, {
        'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
        'content-length': String(stat.size),
        // CES web assets currently use stable filenames (for example renderer.js).
        // Do not cache them across rebuilds or the browser can execute an older
        // renderer against a newer server during development/integration tests.
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'self'",
      })
      if (req.method === 'HEAD') return res.end()
      createReadStream(filePath).pipe(res)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = error instanceof HttpError ? error.status : 400
      trace('request-error', { method: req.method ?? '', url: req.url ?? '', status, message })
      json(res, status, { error: message })
    }
  })

  return {
    server,
    state,
    async listen() {
      await new Promise((resolveListen, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => { server.off('error', reject); resolveListen() })
      })
      return server.address()
    },
    async close() {
      if (!server.listening) return
      await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
    },
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const instance = await createCesEditorServer(options)
  const address = await instance.listen()
  const actualPort = typeof address === 'object' && address ? address.port : options.port
  console.log(`OpenPLC Editor CES web server listening on http://${options.host}:${actualPort}`)
  if (options.debug) {
    console.log('[ces-web][debug] request tracing enabled (authentication tokens are never logged)')
    const staticRoot = resolve(options.staticDir)
    console.log(`[ces-web][debug] static root: ${staticRoot}`)
    try {
      const renderer = await fs.stat(join(staticRoot, 'renderer.js'))
      console.log(`[ces-web][debug] renderer.js: size=${renderer.size} mtime=${renderer.mtime.toISOString()}`)
    } catch (error) {
      console.log(`[ces-web][debug] renderer.js stat failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (options.project) console.log(`Loaded project: ${resolve(options.project)}`)
  if (options.projectRoot) console.log(`Standalone project root: ${resolve(options.projectRoot)}`)
  if (options.initializeNewProject) console.log('Missing standalone projects may be initialized on first open')
  if (options.token) console.log('Session-token authentication enabled for editor APIs')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1 })
}

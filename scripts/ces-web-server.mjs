#!/usr/bin/env node
import { createReadStream, existsSync, promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 43821
const MAX_JSON_BYTES = 16 * 1024 * 1024
const MAX_SYMBOLS = 100_000
const MAX_LIVE_VALUES = 100_000
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
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

      if (req.method === 'GET' && path === '/api/health') {
        return json(res, 200, {
          status: 'ok',
          service: 'openplc-editor-ces',
          documentLoaded: state.document !== null,
          documentRevision: state.documentRevision,
          persistence: state.persistence.kind,
        })
      }

      if (path.startsWith('/api/') && !requireAuth(req, res)) return

      if (req.method === 'POST' && path === '/api/project/open') {
        const body = await readJson(req)
        const { id, projectPath } = resolveProjectUnderRoot(projectRoot, body.projectId)
        const root = await ensureOpenPlcProject(projectPath, initializeNewProject, id)
        state.document = await readProjectDirectory(root)
        state.persistence = { kind: 'filesystem', root, projectId: id }
        state.documentRevision += 1
        return json(res, 200, { success: true, projectId: id, revision: state.documentRevision })
      }

      if (req.method === 'POST' && path === '/api/document/load') {
        state.document = normalizeDocument(await readJson(req))
        state.persistence = { kind: 'rest' }
        state.documentRevision += 1
        return json(res, 200, { success: true, revision: state.documentRevision, document: state.document })
      }
      if (req.method === 'GET' && path === '/api/document') {
        if (!state.document) return json(res, 404, { error: 'no document loaded' })
        return json(res, 200, { revision: state.documentRevision, document: state.document })
      }
      if (req.method === 'GET' && path === '/api/document/raw') {
        const raw = documentAsRawFiles(state.document)
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
        'cache-control': extname(filePath) === '.html' ? 'no-store' : 'public, max-age=3600',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'self'",
      })
      if (req.method === 'HEAD') return res.end()
      createReadStream(filePath).pipe(res)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      json(res, error instanceof HttpError ? error.status : 400, { error: message })
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
  if (options.project) console.log(`Loaded project: ${resolve(options.project)}`)
  if (options.projectRoot) console.log(`Standalone project root: ${resolve(options.projectRoot)}`)
  if (options.initializeNewProject) console.log('Missing standalone projects may be initialized on first open')
  if (options.token) console.log('Session-token authentication enabled for editor APIs')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1 })
}

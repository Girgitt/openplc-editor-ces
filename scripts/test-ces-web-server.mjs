import assert from 'node:assert/strict'
import { existsSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCesEditorServer } from './ces-web-server.mjs'
import { loadProjectViaApi } from './ces-web-load-project.mjs'

const tempRoot = await fs.mkdtemp(join(tmpdir(), 'openplc-ces-web-s1h-'))
const bundledLibraryDir = join(tempRoot, 'bundled-libs')
await fs.mkdir(bundledLibraryDir)
await fs.writeFile(
  join(bundledLibraryDir, 'iec-standard-fb.stlib'),
  JSON.stringify({
    manifest: { name: 'iec-standard-fb', version: '1.0.0', displayName: 'IEC Standard FBs' },
    pous: [],
  }),
)

async function withServer(options, run) {
  const instance = await createCesEditorServer({
    host: '127.0.0.1',
    port: 0,
    staticDir: '/tmp/does-not-exist',
    token: 'secret',
    ...options,
  })
  const address = await instance.listen()
  const base = `http://127.0.0.1:${address.port}`
  const headers = { 'content-type': 'application/json', 'x-ces-editor-token': 'secret' }
  const call = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })
  try {
    await run({ instance, base, call })
  } finally {
    await instance.close()
  }
}

try {
  await withServer({ bundledLibraryDir }, async ({ base, call }) => {
    let response = await fetch(`${base}/api/health`)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).documentLoaded, false)

    response = await fetch(`${base}/api/document`)
    assert.equal(response.status, 401)

    response = await call('/api/project/open', { method: 'POST', body: JSON.stringify({ projectId: 'demo' }) })
    assert.equal(response.status, 409)

    response = await call('/api/document/load', { method: 'POST', body: JSON.stringify({ format: 'plcopen-xml', documentId: 'main', content: '<project />' }) })
    assert.equal(response.status, 200)
    response = await call('/api/document/raw')
    const raw = await response.json()
    assert.equal(raw.data.pendingPlcopenSource, '<project />')

    response = await call('/api/context/libraries')
    assert.equal(response.status, 200)
    const libraries = await response.json()
    assert.equal(libraries.archives.length, 1)
    assert.equal(libraries.archives[0].manifest.name, 'iec-standard-fb')
    assert.deepEqual(libraries.installed[0], {
      name: 'iec-standard-fb',
      version: '1.0.0',
      bundled: true,
      installedAt: '',
      origin: 'bundled',
      displayName: 'IEC Standard FBs',
    })

    response = await call('/api/context/symbols', { method: 'PUT', body: JSON.stringify({ symbols: [
      { id: 'sig:1', name: 'RunFb', displayName: 'Pump / Run feedback', type: 'BOOL', direction: 'input', group: 'Pump P101', binding: 'CES_P101_RUN_FB' },
      { id: 'sig:2', name: 'Speed', type: 'REAL', direction: 'input', group: 'Pump P101', binding: 'CES_P101_SPEED' },
    ] }) })
    assert.equal(response.status, 200)
    response = await call('/api/context/symbols?type=BOOL&q=pump')
    const filtered = await response.json()
    assert.equal(filtered.symbols.length, 1)
    assert.equal(filtered.symbols[0].id, 'sig:1')

    response = await call('/api/live/snapshot', { method: 'POST', body: JSON.stringify({ revision: 7, values: [{ id: 'sig:1', value: true }] }) })
    assert.equal(response.status, 200)
    response = await call('/api/live/snapshot')
    const live = await response.json()
    assert.equal(live.active, true)
    assert.equal(live.revision, 7)
    assert.equal(live.values[0].value, 'true')

    response = await call('/api/live/snapshot', { method: 'POST', body: JSON.stringify({ values: [{ id: 'unknown', value: 1 }] }) })
    assert.equal(response.status, 400)

    const files = {
      projectPath: 'ces-session', projectJson: '{"meta":{"name":"Demo","type":"plc-project"}}', deviceConfig: '{}', pinMapping: '{}',
      pouFiles: [{ relativePath: 'pous/programs/Main.st', content: 'PROGRAM Main\nEND_PROGRAM' }], serverFiles: [], remoteDeviceFiles: [], dataTypeFiles: [], deletions: [],
    }
    response = await call('/api/document/save', {
      method: 'POST',
      body: JSON.stringify({ ...files, pouFiles: [{ relativePath: '../escape.st', content: 'bad' }] }),
    })
    assert.equal(response.status, 400)

    response = await call('/api/document/save', { method: 'POST', body: JSON.stringify(files) })
    assert.equal(response.status, 200)
    const saved = await response.json()
    assert.equal(saved.document.format, 'openplc-project-files')
    assert.equal(saved.document.files.pouFiles[0].content.includes('PROGRAM Main'), true)

    response = await call('/api/document/save-file', {
      method: 'POST',
      body: JSON.stringify({ filePath: 'ces-session/../../escape.st', content: 'bad' }),
    })
    assert.equal(response.status, 400)

    response = await call('/api/live/clear', { method: 'POST', body: '{}' })
    assert.equal(response.status, 200)
    response = await call('/api/live/snapshot')
    assert.equal((await response.json()).active, false)
  })


  const staticRoot = join(tempRoot, 'static')
  await fs.mkdir(staticRoot)
  await fs.writeFile(join(staticRoot, 'index.html'), '<script src="/renderer.js"></script>')
  await fs.writeFile(join(staticRoot, 'renderer.js'), 'console.log("test")')
  await withServer({ staticDir: staticRoot }, async ({ base }) => {
    const response = await fetch(`${base}/renderer.js`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store', 'fixed-name CES web assets must not be cached across rebuilds')
  })

  const projectRoot = join(tempRoot, 'projects')
  await fs.mkdir(projectRoot)

  await withServer({ projectRoot }, async ({ base, call }) => {
    let response = await fetch(`${base}/?project_id=from-static-get`)
    assert.equal(response.status, 503)
    assert.equal(existsSync(join(projectRoot, 'from-static-get')), false, 'static GET must never create/open a project')

    response = await fetch(`${base}/api/project/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'unauthorized' }),
    })
    assert.equal(response.status, 401)
    assert.equal(existsSync(join(projectRoot, 'unauthorized')), false)

    response = await call('/api/project/open', { method: 'POST', body: JSON.stringify({ projectId: 'missing' }) })
    assert.equal(response.status, 404)
    assert.equal(existsSync(join(projectRoot, 'missing')), false)

    for (const invalid of ['../escape', 'nested/project', '/absolute', '.', '..', '%2e%2e']) {
      response = await call('/api/project/open', { method: 'POST', body: JSON.stringify({ projectId: invalid }) })
      assert.equal(response.status, 400, `unsafe project id should fail: ${invalid}`)
    }

    const empty = join(projectRoot, 'empty-project')
    await fs.mkdir(empty)
    response = await call('/api/project/open', { method: 'POST', body: JSON.stringify({ projectId: 'empty-project' }) })
    assert.equal(response.status, 200)
    assert.equal(existsSync(join(empty, 'project.json')), true)
    assert.equal(existsSync(join(empty, 'pous/programs/main.st')), true)

    const initializedProject = JSON.parse(await fs.readFile(join(empty, 'project.json'), 'utf8'))
    assert.deepEqual(initializedProject.meta, { name: 'empty-project', type: 'plc-project' })
    assert.equal(initializedProject.data.configuration.resource.tasks[0].interval, 'T#20ms')

    response = await call('/api/document/raw')
    assert.equal(response.status, 200)
    const opened = await response.json()
    assert.equal(opened.data.projectPath, '/ces-session', 'renderer-facing web path must route as a local project')
    const main = opened.data.pouFiles.find((item) => item.relativePath === 'pous/programs/main.st')
    assert.equal(main.content.includes('PROGRAM main'), true)

    const files = opened.data
    files.projectJson = files.projectJson.replace('empty-project', 'saved-project')
    main.content = 'PROGRAM main\nvalue := 1;\nEND_PROGRAM\n'
    response = await call('/api/document/save', { method: 'POST', body: JSON.stringify(files) })
    assert.equal(response.status, 200)
    assert.equal((await fs.readFile(join(empty, 'project.json'), 'utf8')).includes('saved-project'), true)
    assert.equal((await fs.readFile(join(empty, 'pous/programs/main.st'), 'utf8')).includes('value := 1'), true)

    response = await call('/api/document/save-file', {
      method: 'POST',
      body: JSON.stringify({ filePath: '/ces-session/pous/programs/main.st', content: 'PROGRAM main\nvalue := 2;\nEND_PROGRAM\n' }),
    })
    assert.equal(response.status, 200)
    assert.equal((await fs.readFile(join(empty, 'pous/programs/main.st'), 'utf8')).includes('value := 2'), true)

    const invalidDir = join(projectRoot, 'not-a-project')
    await fs.mkdir(invalidDir)
    await fs.writeFile(join(invalidDir, 'keep.txt'), 'keep me')
    response = await call('/api/project/open', { method: 'POST', body: JSON.stringify({ projectId: 'not-a-project' }) })
    assert.equal(response.status, 409)
    assert.equal(await fs.readFile(join(invalidDir, 'keep.txt'), 'utf8'), 'keep me')
    assert.equal(existsSync(join(invalidDir, 'project.json')), false)
  })

  await withServer({ projectRoot, initializeNewProject: true }, async ({ call }) => {
    const response = await call('/api/project/open', { method: 'POST', body: JSON.stringify({ projectId: 'created-on-demand' }) })
    assert.equal(response.status, 200)
    assert.equal(existsSync(join(projectRoot, 'created-on-demand/project.json')), true)
  })

  const startupEmpty = join(tempRoot, 'startup-empty')
  await fs.mkdir(startupEmpty)
  await withServer({ project: startupEmpty }, async ({ call }) => {
    const response = await call('/api/document/raw')
    assert.equal(response.status, 200)
    assert.equal(existsSync(join(startupEmpty, 'project.json')), true)
  })

  const startupMissing = join(tempRoot, 'startup-missing')
  await assert.rejects(() => createCesEditorServer({ project: startupMissing }), /does not exist/)
  await withServer({ project: startupMissing, initializeNewProject: true }, async ({ call }) => {
    const response = await call('/api/document/raw')
    assert.equal(response.status, 200)
    assert.equal(existsSync(join(startupMissing, 'project.json')), true)
  })

  const restIsolationRoot = join(tempRoot, 'rest-isolation')
  await fs.mkdir(restIsolationRoot)
  await withServer({ project: restIsolationRoot }, async ({ call }) => {
    const before = await fs.readFile(join(restIsolationRoot, 'project.json'), 'utf8')
    const restFiles = {
      projectPath: 'ces-session',
      projectJson: '{"meta":{"name":"REST","type":"plc-project"}}',
      deviceConfig: '{}', pinMapping: '{}', pouFiles: [], serverFiles: [], remoteDeviceFiles: [], dataTypeFiles: [], deletions: [],
    }
    let response = await call('/api/document/load', { method: 'POST', body: JSON.stringify({ format: 'openplc-project-files', files: restFiles }) })
    assert.equal(response.status, 200)
    response = await call('/api/document/save', { method: 'POST', body: JSON.stringify(restFiles) })
    assert.equal(response.status, 200)
    assert.equal(await fs.readFile(join(restIsolationRoot, 'project.json'), 'utf8'), before, 'REST-loaded sessions must not write to a prior filesystem project')
  })

  const apiSource = join(projectRoot, 'empty-project')
  await withServer({}, async ({ base, call }) => {
    await loadProjectViaApi({ server: base, token: 'secret', project: apiSource })
    const response = await call('/api/document/raw')
    assert.equal(response.status, 200)
    const raw = await response.json()
    assert.equal(raw.data.projectPath, '/ces-session')
    assert.equal(raw.data.pouFiles.some((item) => item.relativePath === 'pous/programs/main.st'), true)
  })

  const missingRoot = join(tempRoot, 'no-such-root')
  await assert.rejects(() => createCesEditorServer({ projectRoot: missingRoot }), /project root does not exist/)

  console.log('EDITOR-WEB-S1H server contract: PASS')
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true })
}

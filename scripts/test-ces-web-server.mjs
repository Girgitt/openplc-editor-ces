import assert from 'node:assert/strict'
import { createCesEditorServer } from './ces-web-server.mjs'

const instance = await createCesEditorServer({ host: '127.0.0.1', port: 0, staticDir: '/tmp/does-not-exist', token: 'secret' })
const address = await instance.listen()
const base = `http://127.0.0.1:${address.port}`
const headers = { 'content-type': 'application/json', 'x-ces-editor-token': 'secret' }
const call = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })
try {
  let response = await fetch(`${base}/api/health`)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).documentLoaded, false)

  response = await fetch(`${base}/api/document`)
  assert.equal(response.status, 401)

  response = await call('/api/document/load', { method: 'POST', body: JSON.stringify({ format: 'plcopen-xml', documentId: 'main', content: '<project />' }) })
  assert.equal(response.status, 200)
  response = await call('/api/document/raw')
  const raw = await response.json()
  assert.equal(raw.data.pendingPlcopenSource, '<project />')

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

  console.log('EDITOR-WEB-S1 server contract: PASS')
} finally {
  await instance.close()
}

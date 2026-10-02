#!/usr/bin/env node
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readProjectDirectory } from './ces-web-server.mjs'

function parseArgs(argv) {
  const result = { server: '', token: '', project: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    const next = argv[i + 1]
    if (key === '--server' && next) { result.server = next; i += 1 }
    else if (key === '--token' && next) { result.token = next; i += 1 }
    else if (key === '--project' && next) { result.project = next; i += 1 }
  }
  return result
}

export async function loadProjectViaApi({ server, token, project }) {
  if (!server) throw new Error('--server is required')
  if (!project) throw new Error('--project is required')

  const document = await readProjectDirectory(project)
  const headers = { 'content-type': 'application/json' }
  if (token) headers['x-ces-editor-token'] = token

  const response = await fetch(new URL('/api/document/load', server), {
    method: 'POST',
    headers,
    body: JSON.stringify(document),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`)
  return body
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  await loadProjectViaApi(options)
  console.log(`Loaded OpenPLC project through REST: ${resolve(options.project)}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1 })
}

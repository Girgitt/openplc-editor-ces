#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const editorRoot = resolve(scriptDir, '..')
const packageRoot = join(editorRoot, 'node_modules', 'electron')
const pathFile = join(packageRoot, 'path.txt')

function installedRuntime() {
  if (!existsSync(pathFile)) return null
  const executableName = readFileSync(pathFile, 'utf8').trim()
  if (!executableName) return null
  const distRoot = process.env.ELECTRON_OVERRIDE_DIST_PATH || join(packageRoot, 'dist')
  const executable = join(distRoot, executableName)
  return existsSync(executable) ? executable : null
}

const existing = installedRuntime()
if (existing) process.exit(0)

const installer = join(packageRoot, 'install.js')
if (!existsSync(installer)) {
  throw new Error('Electron npm package is missing; run npm ci before building the CES web editor')
}

console.log('Electron runtime is missing; repairing the local Electron installation...')
const result = spawnSync(process.execPath, [installer], {
  cwd: editorRoot,
  env: process.env,
  stdio: 'inherit',
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

const installed = installedRuntime()
if (!installed) {
  throw new Error('Electron installer completed but the Electron runtime is still unavailable')
}
console.log(`Electron runtime ready: ${installed}`)

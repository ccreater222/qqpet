import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const RUNTIME_DIR = fileURLToPath(new URL('../../src/shared/pet-runtime', import.meta.url))
const WORKSPACE = fileURLToPath(new URL('../../', import.meta.url))

const FORBIDDEN = [
  { name: 'Math.random', pattern: /\bMath\s*\.\s*random\b/g },
  { name: 'Date.now', pattern: /\bDate\s*\.\s*now\b/g },
  { name: 'performance.now', pattern: /\bperformance\s*\.\s*now\b/g },
  { name: 'crypto global', pattern: /\bcrypto\b/g },
  { name: 'new Date()', pattern: /\bnew\s+Date\s*\(\s*\)/g },
  { name: 'timer', pattern: /\b(?:setTimeout|setInterval|clearTimeout|clearInterval|requestAnimationFrame)\s*\(/g },
  { name: 'DOM global', pattern: /\b(?:window|document|localStorage|sessionStorage|navigator|HTMLElement|XMLHttpRequest|WebSocket)\b/g },
  { name: 'network', pattern: /\bfetch\b/g },
  { name: 'Node global', pattern: /\b(?:process|Buffer|require|__dirname|__filename)\b/g },
  { name: 'Electron', pattern: /\b(?:ipcRenderer|ipcMain|electron)\b/g },
]

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function inspect(source) {
  const code = stripComments(source)
  const forbidden = FORBIDDEN
    .filter(rule => {
      rule.pattern.lastIndex = 0
      return rule.pattern.test(code)
    })
    .map(rule => rule.name)
  const badImports = []
  const specifiers = /\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g
  for (const match of code.matchAll(specifiers)) {
    const specifier = match[1]
    if (specifier.startsWith('.') === false || specifier.startsWith('node:')) badImports.push(specifier)
  }
  return { forbidden, badImports }
}

test('pet runtime contains no ambient randomness, wall clock, DOM, network or Node APIs', () => {
  const files = readdirSync(RUNTIME_DIR).filter(name => name.endsWith('.ts')).sort()
  assert.ok(files.length >= 10, 'expected the complete C1 runtime module set')
  for (const name of files) {
    const file = join(RUNTIME_DIR, name)
    const violations = inspect(readFileSync(file, 'utf8'))
    assert.deepEqual(violations.forbidden, [], relative(WORKSPACE, file) + ' uses ambient behavior')
    assert.deepEqual(violations.badImports, [], relative(WORKSPACE, file) + ' has a non-local import')
  }
})

test('static guard rejects each forbidden category and permits explicit injected inputs', () => {
  assert.ok(inspect('const roll = Math.random()').forbidden.includes('Math.random'))
  assert.ok(inspect('const now = Date.now()').forbidden.includes('Date.now'))
  assert.ok(inspect('const now = performance.now()').forbidden.includes('performance.now'))
  assert.ok(inspect('const bytes = crypto.getRandomValues(new Uint8Array(4))').forbidden.includes('crypto global'))
  assert.ok(inspect('const now = new Date()').forbidden.includes('new Date()'))
  assert.ok(inspect('setInterval(tick, 60000)').forbidden.includes('timer'))
  assert.ok(inspect('const root = document.body').forbidden.includes('DOM global'))
  assert.ok(inspect('void fetch(url)').forbidden.includes('network'))
  assert.ok(inspect('const pid = process.pid').forbidden.includes('Node global'))
  assert.ok(inspect("import { ipcMain } from 'electron'").forbidden.includes('Electron'))
  assert.deepEqual(inspect("import fs from 'node:fs'").badImports, ['node:fs'])
  assert.deepEqual(inspect("import path from 'path'").badImports, ['path'])
  assert.deepEqual(inspect("import { x } from './x'").badImports, [])
  assert.deepEqual(inspect('const at = new Date(123)').forbidden, [])
  assert.deepEqual(inspect('const at = Date.UTC(2026, 0, 1)').forbidden, [])
})

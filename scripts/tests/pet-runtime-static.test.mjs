import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'

const RUNTIME_DIR = fileURLToPath(new URL('../../src/shared/pet-runtime', import.meta.url))
const WORKSPACE = fileURLToPath(new URL('../../', import.meta.url))
const SKIP_KEYS = new Set([
  'loc', 'start', 'end', 'range', 'extra', 'tokens', 'comments', 'errors',
  'leadingComments', 'trailingComments', 'innerComments',
])

const AMBIENT_ROOTS = new Map([
  ['window', 'DOM global'],
  ['document', 'DOM global'],
  ['localStorage', 'DOM global'],
  ['sessionStorage', 'DOM global'],
  ['navigator', 'DOM global'],
  ['HTMLElement', 'DOM global'],
  ['XMLHttpRequest', 'DOM global'],
  ['WebSocket', 'DOM global'],
  ['MutationObserver', 'DOM global'],
  ['fetch', 'network'],
  ['setTimeout', 'timer'],
  ['setInterval', 'timer'],
  ['clearTimeout', 'timer'],
  ['clearInterval', 'timer'],
  ['requestAnimationFrame', 'timer'],
  ['cancelAnimationFrame', 'timer'],
  ['process', 'Node global'],
  ['Buffer', 'Node global'],
  ['require', 'Node global'],
  ['__dirname', 'Node global'],
  ['__filename', 'Node global'],
  ['ipcRenderer', 'Electron'],
  ['ipcMain', 'Electron'],
  ['crypto', 'crypto global'],
  ['performance', 'performance.now'],
])

function walk(node, visit, parent = null, parentKey = '') {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, parent, parentKey)
    return
  }
  if (typeof node.type !== 'string') return
  visit(node, parent, parentKey)
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_KEYS.has(key)) continue
    if (value === null || typeof value !== 'object') continue
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit, node, key)
    } else {
      walk(value, visit, node, key)
    }
  }
}

function propertyName(member) {
  if (member.computed === false && member.property.type === 'Identifier') return member.property.name
  if (member.property.type === 'StringLiteral' || member.property.type === 'NumericLiteral') {
    return String(member.property.value)
  }
  return null
}

function expressionChain(node) {
  if (node === null || typeof node !== 'object') return null
  if (node.type === 'Identifier') return [node.name]
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    const base = expressionChain(node.object)
    const property = propertyName(node)
    if (base === null || property === null) return null
    return [...base, property]
  }
  if (node.type === 'ParenthesizedExpression' || node.type === 'TSAsExpression' ||
      node.type === 'TSTypeAssertion' || node.type === 'TSNonNullExpression' ||
      node.type === 'ChainExpression') {
    return expressionChain(node.expression)
  }
  return null
}

function normalizeChain(chain, aliases) {
  let current = chain.slice()
  for (let round = 0; round < 16; round++) {
    if (current.length > 1 && current[0] === 'globalThis') {
      current = current.slice(1)
      continue
    }
    const target = aliases.get(current[0])
    if (target === undefined) break
    current = target.split('.').concat(current.slice(1))
  }
  return current
}

function canonicalPath(node, aliases) {
  const chain = expressionChain(node)
  if (chain === null) return null
  return normalizeChain(chain, aliases).join('.')
}

function ambientViolation(path) {
  if (path === null) return null
  if (path === 'Math.random' || path.startsWith('Math.random.')) return 'Math.random'
  if (path === 'Date.now' || path.startsWith('Date.now.')) return 'Date.now'
  if (path === 'performance.now' || path.startsWith('performance.now.')) return 'performance.now'
  const root = path.split('.')[0]
  return AMBIENT_ROOTS.get(root) ?? null
}

function setAlias(aliases, local, target) {
  if (target === null || aliases.get(local) === target) return false
  aliases.set(local, target)
  return true
}

function boundIdentifier(node) {
  if (node === null || typeof node !== 'object') return null
  if (node.type === 'Identifier') return node.name
  if (node.type === 'AssignmentPattern') return boundIdentifier(node.left)
  return null
}

function bindingPropertyName(node) {
  if (node.computed === false && node.key.type === 'Identifier') return node.key.name
  if (node.key.type === 'StringLiteral' || node.key.type === 'NumericLiteral') return String(node.key.value)
  return null
}

function collectAliases(fileNode) {
  const aliases = new Map()
  for (let round = 0; round < 20; round++) {
    let changed = false
    walk(fileNode, node => {
      if (node.type === 'VariableDeclarator' && node.init !== null) {
        if (node.id.type === 'Identifier') {
          changed = setAlias(aliases, node.id.name, canonicalPath(node.init, aliases)) || changed
        } else if (node.id.type === 'ObjectPattern') {
          const base = canonicalPath(node.init, aliases)
          if (base === null) return
          for (const property of node.id.properties) {
            if (property.type !== 'ObjectProperty') continue
            const key = bindingPropertyName(property)
            const local = boundIdentifier(property.value)
            if (key === null || local === null) continue
            const target = normalizeChain(base.split('.').concat(key), aliases).join('.')
            changed = setAlias(aliases, local, target) || changed
          }
        }
      }
      if (node.type === 'AssignmentExpression' && node.operator === '=' && node.left.type === 'Identifier') {
        changed = setAlias(aliases, node.left.name, canonicalPath(node.right, aliases)) || changed
      }
    })
    if (changed === false) break
  }
  return aliases
}

function isReferenceIdentifier(node, parent, parentKey) {
  if (parent === null) return true
  if (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') {
    return parent.property === node && parent.computed === false ? false : true
  }
  if (parent.type === 'ObjectProperty' || parent.type === 'ObjectMethod') {
    return parent.key === node && parent.computed === false ? false : true
  }
  if (parent.type === 'VariableDeclarator') return parent.id === node ? false : true
  if (parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' || parent.type === 'ClassDeclaration') {
    return parent.id === node ? false : true
  }
  if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' ||
      parent.type === 'ImportNamespaceSpecifier' || parent.type === 'LabeledStatement' ||
      parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') return false
  return parentKey.length > 0
}

function importSpecifier(value) {
  return typeof value === 'string' ? value : null
}

function inspectSource(source, fileName = 'fixture.ts') {
  let fileNode
  try {
    // TypeScript 7's public JS package has no AST parser; Babel's TypeScript
    // syntax plugin provides the parsed AST instead of regex/string scanning.
    fileNode = parse(source, { sourceType: 'module', plugins: ['typescript'] })
  } catch (error) {
    throw new Error(fileName + ': failed to parse TypeScript AST: ' + error.message)
  }
  const aliases = collectAliases(fileNode)
  const forbidden = new Set()
  const badImports = new Set()

  const checkImport = specifier => {
    if (specifier === null) return
    const outsideRuntime = specifier.startsWith('.') === false || specifier.startsWith('node:')
    const rendererImport = /(^|\/)(renderer|main|preload|android|ios|harmony)(\/|$)/.test(specifier)
    if (outsideRuntime || rendererImport) badImports.add(specifier)
  }

  walk(fileNode, (node, parent, parentKey) => {
    if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
      checkImport(importSpecifier(node.source?.value))
    } else if (node.type === 'TSImportEqualsDeclaration' && node.moduleReference.type === 'TSExternalModuleReference') {
      checkImport(importSpecifier(node.moduleReference.expression?.value))
    } else if (node.type === 'ImportExpression') {
      checkImport(importSpecifier(node.source?.value))
    } else if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      if (node.callee.type === 'Import') {
        checkImport(importSpecifier(node.arguments[0]?.value))
      } else {
        const path = canonicalPath(node.callee, aliases)
        if (path === 'Date') forbidden.add('Date()')
        const violation = ambientViolation(path)
        if (violation !== null) forbidden.add(violation)
      }
    } else if (node.type === 'NewExpression') {
      const path = canonicalPath(node.callee, aliases)
      if (path === 'Date' && node.arguments.length === 0) forbidden.add('new Date()')
      const violation = ambientViolation(path)
      if (violation !== null) forbidden.add(violation)
    } else if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
      const violation = ambientViolation(canonicalPath(node, aliases))
      if (violation !== null) forbidden.add(violation)
    } else if (node.type === 'Identifier' && isReferenceIdentifier(node, parent, parentKey)) {
      const violation = ambientViolation(canonicalPath(node, aliases))
      if (violation !== null) forbidden.add(violation)
    }
  })

  for (const target of aliases.values()) {
    const violation = ambientViolation(target)
    if (violation !== null) forbidden.add(violation)
  }
  return { forbidden: [...forbidden].sort(), badImports: [...badImports].sort() }
}

function collectTypeScriptFiles(root) {
  const files = []
  const visit = directory => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path)
    }
  }
  visit(root)
  return files
}

test('pet runtime AST guard scans every TypeScript file recursively', () => {
  const files = collectTypeScriptFiles(RUNTIME_DIR)
  assert.ok(files.length >= 10, 'expected the complete C1 runtime module set')
  for (const file of files) {
    const violations = inspectSource(readFileSync(file, 'utf8'), relative(WORKSPACE, file))
    assert.deepEqual(violations.forbidden, [], relative(WORKSPACE, file) + ' uses ambient behavior')
    assert.deepEqual(violations.badImports, [], relative(WORKSPACE, file) + ' has a forbidden import')
  }

  const fixtureRoot = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.runtime-static-'))
  try {
    mkdirSync(join(fixtureRoot, 'nested'))
    writeFileSync(join(fixtureRoot, 'nested', 'ambient.ts'), 'export const now = Date.now()\n')
    const nestedFiles = collectTypeScriptFiles(fixtureRoot)
    assert.equal(nestedFiles.length, 1)
    const nestedViolations = inspectSource(readFileSync(nestedFiles[0], 'utf8'))
    assert.deepEqual(nestedViolations.forbidden, ['Date.now'])
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('AST guard catches aliases, direct Date calls and computed access', () => {
  const aliasCases = [
    ['const { random } = Math; random()', 'Math.random'],
    ['const { random: r } = Math; r()', 'Math.random'],
    ['const random = Math.random; random()', 'Math.random'],
    ['const M = Math; const r = M.random; r()', 'Math.random'],
    ["const { Date: D } = globalThis; new D()", 'new Date()'],
    ['const D = globalThis.Date; new D()', 'new Date()'],
    ['const { now } = Date; now()', 'Date.now'],
    ["const { setTimeout: later } = globalThis; later(work, 1)", 'timer'],
  ]
  for (const [source, expected] of aliasCases) {
    assert.ok(inspectSource(source).forbidden.includes(expected), source)
  }
  assert.ok(inspectSource('Date()').forbidden.includes('Date()'))
  assert.ok(inspectSource('new globalThis.Date()').forbidden.includes('new Date()'))
  assert.ok(inspectSource("Math['random']()").forbidden.includes('Math.random'))
  assert.ok(inspectSource('globalThis.Date.now()').forbidden.includes('Date.now'))
  assert.ok(inspectSource('const root = document.body').forbidden.includes('DOM global'))
  assert.ok(inspectSource('void fetch(url)').forbidden.includes('network'))
  assert.ok(inspectSource('const pid = process.pid').forbidden.includes('Node global'))
  assert.ok(inspectSource("import { ipcMain } from 'electron'").badImports.includes('electron'))
  assert.deepEqual(inspectSource("import fs from 'node:fs'").badImports, ['node:fs'])
  assert.deepEqual(inspectSource("import path from 'path'").badImports, ['path'])
  assert.deepEqual(inspectSource("import { x } from './x'").badImports, [])
  assert.deepEqual(inspectSource("import('node:fs')").badImports, ['node:fs'])
  assert.deepEqual(inspectSource("import { x } from '../../renderer/pet/store'").badImports, ['../../renderer/pet/store'])
})

test('AST guard ignores comment and string markers but keeps explicit clock inputs legal', () => {
  const markerOnly = [
    "const marker: string = 'Math.random() // Date.now() new Date()'",
    '// const now = Date.now()',
    '/* return Math.random() */',
  ].join('\n')
  assert.deepEqual(inspectSource(markerOnly).forbidden, [])
  assert.deepEqual(inspectSource('const at = new Date(123)').forbidden, [])
  assert.deepEqual(inspectSource('const at = new globalThis.Date(123)').forbidden, [])
  assert.deepEqual(inspectSource('const at = Date.UTC(2026, 0, 1)').forbidden, [])
})

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'

const traverse = traverseModule.default ?? traverseModule
const RUNTIME_DIR = fileURLToPath(new URL('../../src/shared/pet-runtime', import.meta.url))
const WORKSPACE = fileURLToPath(new URL('../../', import.meta.url))

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
  ['self', 'DOM global'],
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
  ['global', 'Node global'],
  ['__dirname', 'Node global'],
  ['__filename', 'Node global'],
  ['ipcRenderer', 'Electron'],
  ['ipcMain', 'Electron'],
  ['crypto', 'crypto global'],
  ['performance', 'performance.now'],
  ['eval', 'eval'],
  ['Function', 'Function'],
])
const DYNAMIC_AMBIENT_ROOTS = new Set(['globalThis', 'Math', 'Date', ...AMBIENT_ROOTS.keys()])
const TS_VALUE_WRAPPERS = new Set([
  'TSAsExpression',
  'TSTypeAssertion',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TSInstantiationExpression',
])

function staticPropertyName(property, computed) {
  if (computed === false && property.type === 'Identifier') return property.name
  if (property.type === 'StringLiteral' || property.type === 'NumericLiteral') return String(property.value)
  return null
}

function normalizeSegments(segments) {
  let current = segments.slice()
  while (current.length > 1 && current[0] === 'globalThis') current = current.slice(1)
  return current
}

function localSegment(binding) {
  return '@local:' + binding.scope.uid + ':' + binding.identifier.start
}

function pathSegments(node, scope, aliases) {
  if (node === null || node === undefined) return null
  if (node.type === 'Identifier') {
    const binding = scope.getBinding(node.name)
    if (binding === undefined) return [node.name]
    const target = aliases.get(binding)
    if (target === undefined) return [localSegment(binding)]
    return normalizeSegments(target.split('.'))
  }
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    const base = pathSegments(node.object, scope, aliases)
    const property = staticPropertyName(node.property, node.computed)
    if (base === null || property === null) return null
    return normalizeSegments([...base, property])
  }
  if (node.type === 'ParenthesizedExpression' || node.type === 'ChainExpression' ||
      TS_VALUE_WRAPPERS.has(node.type)) {
    return pathSegments(node.expression, scope, aliases)
  }
  return null
}

function pathString(node, scope, aliases) {
  const segments = pathSegments(node, scope, aliases)
  return segments === null ? null : segments.join('.')
}

function ambientViolation(path) {
  if (path === null) return null
  if (path === 'Math.random' || path.startsWith('Math.random.')) return 'Math.random'
  if (path === 'Date.now' || path.startsWith('Date.now.')) return 'Date.now'
  if (path === 'performance.now' || path.startsWith('performance.now.')) return 'performance.now'
  return AMBIENT_ROOTS.get(path.split('.')[0]) ?? null
}

function isAmbientBase(segments) {
  if (segments === null || segments.length === 0) return false
  const path = segments.join('.')
  return DYNAMIC_AMBIENT_ROOTS.has(path) || ambientViolation(path) !== null
}

function assignAlias(aliases, binding, segments) {
  if (binding === undefined) return false
  const target = normalizeSegments(segments).join('.')
  if (aliases.get(binding) === target) return false
  aliases.set(binding, target)
  return true
}

function bindPattern(patternPath, baseSegments, aliases, dynamicViolations) {
  if (patternPath.node === null || patternPath.node === undefined) return false
  if (patternPath.isAssignmentPattern()) {
    return bindPattern(patternPath.get('left'), baseSegments, aliases, dynamicViolations)
  }
  if (patternPath.isIdentifier()) {
    const binding = patternPath.scope.getBinding(patternPath.node.name)
    return assignAlias(aliases, binding, baseSegments)
  }
  if (patternPath.isObjectPattern()) {
    let changed = false
    for (const propertyPath of patternPath.get('properties')) {
      if (propertyPath.isObjectProperty() === false) continue
      const key = staticPropertyName(propertyPath.node.key, propertyPath.node.computed)
      if (key === null) {
        if (isAmbientBase(baseSegments)) dynamicViolations.add('dynamic ambient access')
        continue
      }
      const childBase = normalizeSegments([...baseSegments, key])
      changed = bindPattern(propertyPath.get('value'), childBase, aliases, dynamicViolations) || changed
    }
    return changed
  }
  if (patternPath.isArrayPattern()) {
    let changed = false
    const elements = patternPath.get('elements')
    for (let index = 0; index < elements.length; index++) {
      const element = elements[index]
      if (element.node === null || element.node === undefined) continue
      changed = bindPattern(element, [...baseSegments, String(index)], aliases, dynamicViolations) || changed
    }
    return changed
  }
  return false
}

function collectAliases(fileNode) {
  const aliases = new Map()
  const dynamicViolations = new Set()
  for (let round = 0; round < 20; round++) {
    let changed = false
    traverse(fileNode, {
      VariableDeclarator(path) {
        if (path.node.init === null) return
        const initPath = path.get('init')
        const base = pathSegments(initPath.node, initPath.scope, aliases)
        if (base === null) return
        const idPath = path.get('id')
        if (idPath.isIdentifier()) {
          changed = assignAlias(aliases, idPath.scope.getBinding(idPath.node.name), base) || changed
        } else if (idPath.isObjectPattern() || idPath.isArrayPattern()) {
          changed = bindPattern(idPath, base, aliases, dynamicViolations) || changed
        }
      },
      AssignmentExpression(path) {
        if (path.node.operator !== '=') return
        const rightPath = path.get('right')
        const base = pathSegments(rightPath.node, rightPath.scope, aliases)
        if (base === null) return
        const leftPath = path.get('left')
        if (leftPath.isIdentifier()) {
          changed = assignAlias(aliases, leftPath.scope.getBinding(leftPath.node.name), base) || changed
        } else if (leftPath.isObjectPattern() || leftPath.isArrayPattern()) {
          changed = bindPattern(leftPath, base, aliases, dynamicViolations) || changed
        }
      },
    })
    if (changed === false) break
  }
  return { aliases, dynamicViolations }
}

function isTypePosition(path) {
  let current = path.parentPath
  while (current !== null) {
    const type = current.node?.type
    if (typeof type === 'string' && type.startsWith('TS') && TS_VALUE_WRAPPERS.has(type) === false) return true
    current = current.parentPath
  }
  return false
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

  const { aliases, dynamicViolations } = collectAliases(fileNode)
  const forbidden = new Set(dynamicViolations)
  const badImports = new Set()

  const checkImport = specifier => {
    if (specifier === null) return
    const outsideRuntime = specifier.startsWith('.') === false || specifier.startsWith('node:')
    const rendererImport = /(^|\/)(renderer|main|preload|android|ios|harmony)(\/|$)/.test(specifier)
    if (outsideRuntime || rendererImport) badImports.add(specifier)
  }

  const inspectMember = path => {
    const objectSegments = pathSegments(path.node.object, path.scope, aliases)
    const property = staticPropertyName(path.node.property, path.node.computed)
    if (path.node.computed === true && property === null && isAmbientBase(objectSegments)) {
      forbidden.add('dynamic ambient access')
    }
    if (objectSegments !== null && property !== null) {
      const violation = ambientViolation(normalizeSegments([...objectSegments, property]).join('.'))
      if (violation !== null) forbidden.add(violation)
    }
  }

  const inspectCall = path => {
    const target = pathString(path.node.callee, path.scope, aliases)
    if (target === 'Date') forbidden.add('Date()')
    const violation = ambientViolation(target)
    if (violation !== null) forbidden.add(violation)
  }

  traverse(fileNode, {
    ImportDeclaration(path) {
      checkImport(importSpecifier(path.node.source.value))
    },
    ExportNamedDeclaration(path) {
      checkImport(importSpecifier(path.node.source?.value))
    },
    ExportAllDeclaration(path) {
      checkImport(importSpecifier(path.node.source?.value))
    },
    TSImportEqualsDeclaration(path) {
      if (path.node.moduleReference.type === 'TSExternalModuleReference') {
        checkImport(importSpecifier(path.node.moduleReference.expression?.value))
      }
    },
    ImportExpression(path) {
      const sourcePath = path.get('source')
      if (sourcePath.isStringLiteral()) checkImport(sourcePath.node.value)
      else forbidden.add('non-literal dynamic import')
    },
    CallExpression(path) {
      if (path.node.callee.type === 'Import') {
        const argument = path.node.arguments[0]
        if (path.node.arguments.length !== 1 || argument?.type !== 'StringLiteral') {
          forbidden.add('non-literal dynamic import')
        } else {
          checkImport(argument.value)
        }
        return
      }
      inspectCall(path)
    },
    OptionalCallExpression(path) {
      inspectCall(path)
    },
    NewExpression(path) {
      const target = pathString(path.node.callee, path.scope, aliases)
      if (target === 'Date' && path.node.arguments.length === 0) forbidden.add('new Date()')
      const violation = ambientViolation(target)
      if (violation !== null) forbidden.add(violation)
    },
    MemberExpression(path) {
      inspectMember(path)
    },
    OptionalMemberExpression(path) {
      inspectMember(path)
    },
    Identifier(path) {
      if (path.isReferencedIdentifier() === false || isTypePosition(path)) return
      const violation = ambientViolation(pathString(path.node, path.scope, aliases))
      if (violation !== null) forbidden.add(violation)
    },
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

test('AST guard catches aliases, nested destructuring, computed access and dynamic import', () => {
  const aliasCases = [
    ['const { random } = Math; random()', 'Math.random'],
    ['const { random: r } = Math; r()', 'Math.random'],
    ['const random = Math.random; random()', 'Math.random'],
    ['const M = Math; const r = M.random; r()', 'Math.random'],
    ['const { Math: { random } } = globalThis; random()', 'Math.random'],
    ['let random; ({ Math: { random } } = globalThis); random()', 'Math.random'],
    ["const { Date: D } = globalThis; new D()", 'new Date()'],
    ['const D = globalThis.Date; new D()', 'new Date()'],
    ['const { now } = Date; now()', 'Date.now'],
    ["const { setTimeout: later } = globalThis; later(work, 1)", 'timer'],
    ['const F = Function; new F()', 'Function'],
    ['const { Function: F } = globalThis; F()', 'Function'],
    ['const e = eval; e(code)', 'eval'],
    ['const { eval: e } = globalThis; e(code)', 'eval'],
  ]
  for (const [source, expected] of aliasCases) {
    assert.ok(inspectSource(source).forbidden.includes(expected), source)
  }
  assert.ok(inspectSource('Date()').forbidden.includes('Date()'))
  assert.ok(inspectSource('new globalThis.Date()').forbidden.includes('new Date()'))
  assert.ok(inspectSource("Math['random']()").forbidden.includes('Math.random'))
  assert.ok(inspectSource("Math['ran' + 'dom']()").forbidden.includes('dynamic ambient access'))
  assert.ok(inspectSource("globalThis['fet' + 'ch'](url)").forbidden.includes('dynamic ambient access'))
  assert.ok(inspectSource("const M = Math; M['ran' + 'dom']()").forbidden.includes('dynamic ambient access'))
  assert.ok(inspectSource("const g = globalThis; g['fet' + 'ch'](url)").forbidden.includes('dynamic ambient access'))
  assert.ok(inspectSource("const { [key]: value } = Math").forbidden.includes('dynamic ambient access'))
  assert.ok(inspectSource("const { Math: { [key]: value } } = globalThis").forbidden.includes('dynamic ambient access'))
  assert.ok(inspectSource('globalThis.Date.now()').forbidden.includes('Date.now'))
  assert.ok(inspectSource('const root = document.body').forbidden.includes('DOM global'))
  assert.ok(inspectSource('void fetch(url)').forbidden.includes('network'))
  assert.ok(inspectSource('const pid = process.pid').forbidden.includes('Node global'))
  assert.ok(inspectSource('eval(source)').forbidden.includes('eval'))
  assert.ok(inspectSource('Function(source)').forbidden.includes('Function'))
  assert.ok(inspectSource('new Function(source)').forbidden.includes('Function'))
  assert.ok(inspectSource('import(modulePath)').forbidden.includes('non-literal dynamic import'))
  assert.ok(inspectSource('import(`./${name}`)').forbidden.includes('non-literal dynamic import'))
  assert.ok(inspectSource("import { ipcMain } from 'electron'").badImports.includes('electron'))
  assert.deepEqual(inspectSource("import fs from 'node:fs'").badImports, ['node:fs'])
  assert.deepEqual(inspectSource("import path from 'path'").badImports, ['path'])
  assert.deepEqual(inspectSource("import { x } from './x'").badImports, [])
  assert.deepEqual(inspectSource("import('./x')").badImports, [])
  assert.deepEqual(inspectSource("import('./x')").forbidden, [])
  assert.deepEqual(inspectSource("import('node:fs')").badImports, ['node:fs'])
  assert.deepEqual(inspectSource("import { x } from '../../renderer/pet/store'").badImports, ['../../renderer/pet/store'])
})

test('AST guard resolves lexical bindings without ambient false positives', () => {
  const safeSources = [
    'const fetch = () => 1; fetch()',
    'function run(fetch) { return fetch() }',
    'function run(Math) { return Math.random() }',
    'function run(Date) { return new Date() }',
    'function run(Function) { return new Function() }',
    'function outer() { const M = Math }\nfunction inner() { const M = { random: () => 1 }; return M.random() }',
    'const M = { random: () => 1 }; M.random()',
    'function run(Math) { return Math["ran" + "dom"]() }',
    'const local = {}; local["fet" + "ch"]()',
    'const object = {}; object["fetch"]()',
    'const root: Function = () => 1; root()',
  ]
  for (const source of safeSources) {
    assert.deepEqual(inspectSource(source).forbidden, [], source)
  }
  assert.ok(inspectSource('function outer() { const fetch = globalThis.fetch }\nfunction inner(fetch) { return fetch() }').forbidden.includes('network'))
  assert.ok(inspectSource('function inner(fetch) { return fetch() } fetch()').forbidden.includes('network'))
  assert.ok(inspectSource('const local = {}; local.fetch()').forbidden.includes('network') === false)
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

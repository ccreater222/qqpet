import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import { parse } from '@babel/parser'

const STORE_FILE = new URL('../../src/renderer/pet/store.ts', import.meta.url)
const ITEMS_FILE = new URL('../../src/renderer/pet/items.ts', import.meta.url)

function programBody(file) {
  const source = readFileSync(file, 'utf8')
  const fileNode = parse(source, { sourceType: 'module', plugins: ['typescript'] })
  return { source, body: fileNode.program.body }
}

function declarationOf(entry) {
  if (entry.type === 'ExportNamedDeclaration' || entry.type === 'ExportDefaultDeclaration') return entry.declaration
  return entry
}

function topLevelFunction({ source, body }, name) {
  const node = body.map(declarationOf).find(entry =>
    entry?.type === 'FunctionDeclaration' && entry.id?.name === name,
  )
  if (node === undefined) throw new Error('missing renderer function ' + name)
  return source.slice(node.start, node.end)
}

function topLevelVariable({ source, body }, name) {
  const node = body.map(declarationOf).find(entry =>
    entry?.type === 'VariableDeclaration' && entry.declarations.some(declaration =>
      declaration.id.type === 'Identifier' && declaration.id.name === name,
    ),
  )
  if (node === undefined) throw new Error('missing renderer constant ' + name)
  return source.slice(node.start, node.end)
}

function executable(fragments, expose) {
  return stripTypeScriptTypes(fragments.join('\n\n') + '\n' + expose, { mode: 'transform' })
}

/**
 * Runs the exact growth/fatigue/luck source from the current renderer store in
 * a small VM. Tests provide the same `info`/`save` objects used by extraction
 * and can pass the real goods resolver for timed-good group bonuses.
 */
export function createLegacyStoreAdapter() {
  const store = programBody(STORE_FILE)
  const script = executable([
    topLevelVariable(store, 'MOODS'),
    topLevelFunction(store, 'growthPerMinute'),
    topLevelFunction(store, 'fatigue'),
    topLevelFunction(store, 'luck'),
  ], 'this.__legacyStore = { growthPerMinute, fatigue, luck }')
  const context = {
    info: {},
    save: {},
    goodOf: () => ({}),
    busy: () => false,
  }
  vm.createContext(context)
  vm.runInContext(script, context)

  const bind = input => {
    context.info = { ...input.info }
    context.save = input.save ? structuredClone(input.save) : {}
    context.goodOf = input.goodOf ?? (() => ({}))
    context.busy = () => Boolean(input.busy)
  }

  return {
    growthPerMinute(input) {
      bind(input)
      return context.__legacyStore.growthPerMinute()
    },
    fatigue(input) {
      bind(input)
      return context.__legacyStore.fatigue()
    },
    luck(input) {
      bind(input)
      return context.__legacyStore.luck()
    },
  }
}

/** Runs the exact `apply(g, extra)` source from the current renderer items module. */
export function createLegacyGoodApplyAdapter() {
  const items = programBody(ITEMS_FILE)
  const script = executable([
    topLevelFunction(items, 'apply'),
  ], 'this.__legacyApply = apply')
  const context = {
    info: {},
    save: {},
    moodEffects: [],
    setInfo(key, value) {
      context.info[key] = value
    },
    addInfo(key, delta) {
      context.info[key] += delta
    },
    floatMood(value) {
      context.moodEffects.push(value)
    },
  }
  vm.createContext(context)
  vm.runInContext(script, context)

  return {
    apply(current, caps, effect, extraMood = 0) {
      context.info = { ...current }
      context.save = { petComputedlInfo: { ...caps } }
      context.moodEffects = []
      context.__legacyApply(effect, extraMood)
      return {
        hunger: context.info.hunger,
        clean: context.info.clean,
        mood: context.info.mood,
        intel: context.info.intel,
        charm: context.info.charm,
        strong: context.info.strong,
      }
    },
  }
}

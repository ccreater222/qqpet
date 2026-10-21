import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const { uiCommands } = await import('../../src/renderer/pet/command-map.ts')

function strippedSource(relativePath) {
  return stripTypeScriptTypes(readFileSync(new URL(relativePath, import.meta.url), 'utf8'), { mode: 'transform' })
    .replace(/^import .*$/gm, '')
    .replace(/^export \{.*\}$/gm, '')
    .replace(/^export /gm, '')
}

function loadConverted(relativePath, scope, expose) {
  const context = { ...scope }
  runInNewContext(strippedSource(relativePath) + '\nthis.__converted = { ' + expose + ' }', context)
  return context.__converted
}

test('Group F fishing intents map to exact typed command payloads', () => {
  assert.deepEqual(uiCommands.fishingBuy(1001, 3), { type: 'fishing.buy', payload: { fryId: 1001, quantity: 3 } })
  assert.deepEqual(uiCommands.fishingFeed(42), { type: 'fishing.feed', payload: { fishId: 42 } })
  assert.deepEqual(uiCommands.fishingHarvest(42), { type: 'fishing.harvest', payload: { fishId: 42 } })
  assert.deepEqual(uiCommands.fishingHarvestAll(), { type: 'fishing.harvestAll', payload: {} })
  assert.deepEqual(uiCommands.fishingSpeedUp(), { type: 'fishing.speedUp', payload: {} })
})

test('runtime pond reads projection state without settling or writing canonical fish data', () => {
  const writes = []
  const fish = { id: 7, fryid: 1001, name: '小鱼', stage: 2, time: 10, interval: 3600, costyb: 50, YB: 80, quantity: 1, basequantity: 1, avatar: 1, AIXIN: 0, growth: 0, strong: 0, iq: 0, charm: 0, born: 100, siLiao: 0 }
  const save = {
    saveJsonData: { fishs: JSON.stringify({ PD: { allvipcnt: 2, canusecnt: 1 }, fishs: [fish] }) },
    gameSaveDatas: { fishing_harvestfish: 3, yyds: 0 },
  }
  const pond = loadConverted('../../src/renderer/pet/fishing.ts', {
    runtimeProjectionMode: true,
    info: { yb: 500, pinkDiamond: false, PDiamondLevel: 1 },
    save,
    setInfo: (...args) => writes.push(['setInfo', ...args]),
    update: (...args) => writes.push(['update', ...args]),
    earnYb: (...args) => writes.push(['earnYb', ...args]),
    windowView: () => {},
    registerProjectionCacheInvalidator: () => () => {},
    FRIES: [],
  }, 'pondState, pondRoom, pondCommand, resetFish')
  const state = pond.pondState()
  assert.equal(state.yb, 500)
  assert.equal(state.harvestfish, 3)
  assert.equal(state.fishes.length, 1)
  assert.equal(state.canusecnt, 1)
  assert.equal(pond.pondRoom(), 2, 'three slots minus one projected fish')
  assert.deepEqual(JSON.parse(JSON.stringify(pond.pondCommand(2, { id: 7, paytype: 0, fryid: 0 }))), { result: 5, msg: '该操作需要走运行时命令' })
  pond.resetFish()
  assert.deepEqual(writes, [], 'runtime pond reads and rejected mutations never touch canonical store helpers')
})

test('converted fishing UI routes every SWF mutation through the runtime bridge', () => {
  const source = readFileSync(new URL('../../src/renderer/ui/fishing.ts', import.meta.url), 'utf8')
  assert.match(source, /runtimeProjectionMode/)
  assert.match(source, /handleRuntimeCommand/)
  assert.match(source, /uiCommands\.fishingFeed/)
  assert.match(source, /uiCommands\.fishingBuy/)
  assert.match(source, /uiCommands\.fishingHarvest/)
  assert.match(source, /uiCommands\.fishingHarvestAll/)
  assert.match(source, /uiCommands\.fishingSpeedUp/)
  assert.match(source, /commandResultData<\{ yb: number \}>/)
  assert.doesNotMatch(source, /pondCommand\(head\.cmd, data\)\n    void send\(head\.cmd, reply\)[\s\S]*runtimeProjectionMode/)
})

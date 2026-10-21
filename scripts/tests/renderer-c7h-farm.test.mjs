import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const { uiCommands } = await import('../../src/renderer/pet/command-map.ts')
const FARM = JSON.parse(readFileSync(new URL('../../src/shared/pet-runtime/content/farm.json', import.meta.url), 'utf8'))

function strippedSource(relativePath) {
  return stripTypeScriptTypes(readFileSync(new URL(relativePath, import.meta.url), 'utf8'), { mode: 'transform' })
    .replace(/^import .*$/gm, '')
    .replace(/^export \{.*\}$/gm, '')
    .replace(/^export /gm, '')
}

function loadFarm(scope, expose) {
  const context = { ...scope }
  runInNewContext(strippedSource('../../src/renderer/ui/farm.ts') + '\nthis.__farm = { ' + expose + ' }', context)
  return context.__farm
}

test('farm intents map to exact typed command payloads', () => {
  assert.deepEqual(uiCommands.farmBuySeed('RadishSeed', 2), { type: 'farm.buySeed', payload: { seedId: 'RadishSeed', quantity: 2 } })
  assert.deepEqual(uiCommands.farmPlant('RadishSeed', [0, 1]), { type: 'farm.plant', payload: { seedId: 'RadishSeed', plotIds: [0, 1] } })
  assert.deepEqual(uiCommands.farmCare([0, 1], 'water'), { type: 'farm.care', payload: { plotIds: [0, 1], action: 'water' } })
  assert.deepEqual(uiCommands.farmHarvest([2]), { type: 'farm.harvest', payload: { plotIds: [2] } })
  assert.deepEqual(uiCommands.farmClear([2]), { type: 'farm.clear', payload: { plotIds: [2] } })
  assert.deepEqual(uiCommands.farmSellProduce('Radish', 3), { type: 'farm.sellProduce', payload: { itemId: 'Radish', quantity: 3 } })
})

test('runtime farm renders projection labels and farmNews never writes canonical state', async () => {
  const now = Math.floor(Date.now() / 1000)
  const stored = JSON.stringify({
    experience: 10,
    rank: 2,
    weather: 'Sunny',
    farmland: [
      { farmland: 'FarmlandS', crop: 'RadishSeed', time: now - 100000, state: 5, progress: 1 },
      { farmland: 'FarmlandG', crop: 'CarrotSeed', time: now - 10, state: 0, progress: 0.5, grass: 1 },
    ],
  })
  const writes = []
  const farm = loadFarm({
    runtimeProjectionMode: true,
    info: { yb: 500, name: 'pet' },
    save: { saveJsonData: { farm: stored }, petInfo: { yb: 500, name: 'pet' } },
    location: { hostname: 'test' },
    localStorage: { getItem: () => null, setItem: () => {} },
    registerProjectionCacheInvalidator: () => {},
    update: (...args) => writes.push(['update', ...args]),
    setInfo: (...args) => writes.push(['setInfo', ...args]),
    writeSol: (...args) => writes.push(['writeSol', ...args]),
    readSol: () => null,
    onSaveFlush: () => () => {},
    onProjectionApplied: () => () => {},
    FARM,
    div: () => ({ append: () => {}, textContent: '' }),
    button: () => ({ append: () => {}, addEventListener: () => {} }),
    img: () => ({}),
    avatar: () => '',
    scaleYb: (value) => value,
    openBox: () => () => {},
    SwfPlayer: class {},
    window: { qqpet: { setFocusable: () => {} } },
  }, 'runtimeFarmPlotLabels, farmNews, save')
  const labels = farm.runtimeFarmPlotLabels(stored)
  assert.equal(labels.length, 18)
  assert.match(labels[0], /可收获/)
  assert.match(labels[1], /旱/)
  assert.match(labels[1], /草/)
  assert.match(labels[1], /胡萝卜/)
  assert.match(labels[2], /空地/)
  const news = await farm.farmNews()
  assert.deepEqual(JSON.parse(JSON.stringify(news)), { ripe: 1, pests: 1 })
  assert.deepEqual(writes, [])
  assert.equal(farm.save.saveJsonData.farm, stored)
})

test('runtime farm branch dispatches only commands and leaves the SWF path intact', () => {
  const source = readFileSync(new URL('../../src/renderer/ui/farm.ts', import.meta.url), 'utf8')
  const runtimeStart = source.indexOf('function openRuntimeFarm')
  const runtimeEnd = source.indexOf('\nfunction fresh', runtimeStart)
  assert.ok(runtimeStart >= 0 && runtimeEnd > runtimeStart)
  const runtimeBody = source.slice(runtimeStart, runtimeEnd)
  for (const call of ['farmBuySeed', 'farmPlant', 'farmCare', 'farmHarvest', 'farmClear', 'farmSellProduce']) {
    assert.match(runtimeBody, new RegExp('uiCommands\\.' + call))
  }
  assert.doesNotMatch(runtimeBody, /\b(update|setInfo|writeSol)\s*\(/)
  const openFarmBody = source.slice(source.indexOf('export function openFarm'), source.indexOf("registerProjectionCacheInvalidator('farm'"))
  assert.match(openFarmBody, /player\.load\('pet\/qqfarm\/Farm\.swf'/)
  assert.match(openFarmBody, /writeSol\(KEY/)
  const newsBody = source.slice(source.indexOf('export async function farmNews'), source.indexOf('ripening ??= ripeTimes()'))
  assert.doesNotMatch(newsBody, /update\('saveJsonData'/)
})

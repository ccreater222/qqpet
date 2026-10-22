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
  assert.deepEqual(uiCommands.farmReclaim([6, 7]), { type: 'farm.reclaim', payload: { plotIds: [6, 7] } })
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
  }, 'runtimeFarmPlotLabels, runtimeFarmWastelandPlotIds, farmNews, save')
  const labels = farm.runtimeFarmPlotLabels(stored)
  assert.equal(labels.length, 18)
  assert.match(labels[0], /可收获/)
  assert.match(labels[1], /旱/)
  assert.match(labels[1], /草/)
  assert.match(labels[1], /胡萝卜/)
  assert.match(labels[2], /空地/)
  assert.deepEqual(Array.from(farm.runtimeFarmWastelandPlotIds(stored)), Array.from({ length: 12 }, (_, index) => index + 6))
  const news = await farm.farmNews()
  assert.deepEqual(JSON.parse(JSON.stringify(news)), { ripe: 1, pests: 1 })
  assert.deepEqual(writes, [])
  assert.equal(farm.save.saveJsonData.farm, stored)
})

function fakeNode(className = '') {
  const node = {
    className,
    children: [],
    _text: '',
    append(...items) {
      for (const item of items) this.children.push(item)
    },
    addEventListener(type, listener) {
      if (type === 'click') this.onClick = listener
    },
    click() {
      this.onClick?.()
    },
  }
  Object.defineProperty(node, 'textContent', {
    get() { return this._text },
    set(value) {
      this._text = String(value)
      if (this._text === '') this.children = []
    },
  })
  return node
}

function nodeText(node) {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  return (node.children ?? []).map(nodeText).join('')
}

function findButton(root, text) {
  if (root !== null && typeof root === 'object') {
    if (typeof root.click === 'function' && nodeText(root) === text) return root
    for (const child of root.children ?? []) {
      const found = findButton(child, text)
      if (found !== null) return found
    }
  }
  return null
}

test('runtime reclaim control dispatches selected wasteland ids and rerenders from the projection', async () => {
  const stored = JSON.stringify({
    experience: '1', rank: '01', wealth: 500, weather: 'Sunny', burden: [], warehouse: [],
    farmland: Array.from({ length: 18 }, (_, index) => ({ farmland: index < 6 ? 'FarmlandS' : 'Wasteland' })),
  })
  const reclaimed = JSON.stringify({
    experience: '1', rank: '01', wealth: 500, weather: 'Sunny', burden: [], warehouse: [],
    farmland: Array.from({ length: 18 }, (_, index) => ({ farmland: index < 8 ? 'FarmlandS' : 'Wasteland' })),
  })
  const commands = []
  let projectionListener = null
  let content = null
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
    onProjectionApplied: (listener) => { projectionListener = listener; return () => {} },
    uiCommands,
    dispatchRuntimeCommand: async (command) => {
      commands.push(command)
      farm.save.saveJsonData.farm = reclaimed
      projectionListener?.()
      return { status: 'applied' }
    },
    commandSucceeded: (result) => result?.status === 'applied',
    commandErrorText: (error) => error.message,
    FARM,
    div: (className, ...children) => {
      const node = fakeNode(className)
      node.append(...children)
      return node
    },
    button: (className, onClick, ...children) => {
      const node = fakeNode(className)
      node.append(...children)
      node.addEventListener('click', onClick)
      return node
    },
    img: () => fakeNode(),
    avatar: () => '',
    scaleYb: (value) => value,
    openBox: (value) => { content = value; return () => {} },
    SwfPlayer: class {},
    window: { qqpet: { setFocusable: () => {} } },
  }, 'openFarm, runtimeFarmPlotLabels, runtimeFarmWastelandPlotIds, save')
  farm.openFarm()
  assert.ok(content !== null)
  assert.match(findButton(content, '7 荒地').className, /farmPlot/)

  findButton(content, '7 荒地').click()
  findButton(content, '8 荒地').click()
  findButton(content, '开垦荒地').click()
  await Promise.resolve()
  await Promise.resolve()

  assert.deepEqual(JSON.parse(JSON.stringify(commands)), [{ type: 'farm.reclaim', payload: { plotIds: [6, 7] } }])
  assert.equal(findButton(content, '7 空地') !== null, true)
  assert.equal(findButton(content, '8 空地') !== null, true)
  assert.equal(farm.runtimeFarmPlotLabels(farm.save.saveJsonData.farm)[6], '7 空地')
  assert.deepEqual(writes, [])

  // A later projection changes the remaining reclaimable set without any local write.
  farm.save.saveJsonData.farm = reclaimed
  projectionListener?.()
  assert.deepEqual(Array.from(farm.runtimeFarmWastelandPlotIds(farm.save.saveJsonData.farm)), Array.from({ length: 10 }, (_, index) => index + 8))
  assert.deepEqual(writes, [])
})

test('runtime farm branch dispatches only commands and leaves the SWF path intact', () => {
  const source = readFileSync(new URL('../../src/renderer/ui/farm.ts', import.meta.url), 'utf8')
  const runtimeStart = source.indexOf('function openRuntimeFarm')
  const runtimeEnd = source.indexOf('\nfunction fresh', runtimeStart)
  assert.ok(runtimeStart >= 0 && runtimeEnd > runtimeStart)
  const runtimeBody = source.slice(runtimeStart, runtimeEnd)
  for (const call of ['farmBuySeed', 'farmReclaim', 'farmPlant', 'farmCare', 'farmHarvest', 'farmClear', 'farmSellProduce']) {
    assert.match(runtimeBody, new RegExp('uiCommands\\.' + call))
  }
  assert.doesNotMatch(runtimeBody, /\b(update|setInfo|writeSol)\s*\(/)
  const openFarmBody = source.slice(source.indexOf('export function openFarm'), source.indexOf("registerProjectionCacheInvalidator('farm'"))
  assert.match(openFarmBody, /player\.load\('pet\/qqfarm\/Farm\.swf'/)
  assert.match(openFarmBody, /writeSol\(KEY/)
  const newsBody = source.slice(source.indexOf('export async function farmNews'), source.indexOf('ripening ??= ripeTimes()'))
  assert.doesNotMatch(newsBody, /update\('saveJsonData'/)
})

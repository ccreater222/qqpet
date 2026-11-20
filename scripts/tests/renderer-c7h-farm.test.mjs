import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const { uiCommands } = await import('../../src/renderer/pet/command-map.ts')
const FARM = JSON.parse(readFileSync(new URL('../../src/shared/pet-runtime/content/farm.json', import.meta.url), 'utf8'))
const { FARM_MAX_PLOTS } = await import('../../src/shared/pet-runtime/farm-limits.ts')

function strippedSource(relativePath) {
  return stripTypeScriptTypes(readFileSync(new URL(relativePath, import.meta.url), 'utf8'), { mode: 'transform' })
    .replace(/^import .*$/gm, '')
    .replace(/^export \{.*\}$/gm, '')
    .replace(/^export /gm, '')
}

function loadFarm(scope, expose) {
  const context = { FARM_MAX_PLOTS, ...scope }
  runInNewContext(strippedSource('../../src/renderer/ui/farm.ts') + '\nthis.__farm = { ' + expose + ' }', context)
  return context.__farm
}

test('farm intents map to exact typed command payloads', () => {
  assert.deepEqual(uiCommands.farmBuySeed('RadishSeed', 2), { type: 'farm.buySeed', payload: { seedId: 'RadishSeed', quantity: 2 } })
  assert.deepEqual(uiCommands.farmBuyFertilizer('Fertilizer', 2), { type: 'farm.buyFertilizer', payload: { fertilizerId: 'Fertilizer', quantity: 2 } })
  assert.deepEqual(uiCommands.farmPlant('RadishSeed', [0, 1]), { type: 'farm.plant', payload: { seedId: 'RadishSeed', plotIds: [0, 1] } })
  assert.deepEqual(uiCommands.farmReclaim([6, 7]), { type: 'farm.reclaim', payload: { plotIds: [6, 7] } })
  assert.deepEqual(uiCommands.farmCare([0, 1], 'water'), { type: 'farm.care', payload: { plotIds: [0, 1], action: 'water' } })
  assert.deepEqual(uiCommands.farmCare([3, 4], 'fertilize'), { type: 'farm.care', payload: { plotIds: [3, 4], action: 'fertilize' } })
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
    currentProjectionView: () => ({ gameTimeMs: now * 1000, timeZone: 'UTC' }),
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
    phoneUI: () => false,
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
  assert.match(labels[2], /未导入/)
  assert.deepEqual(Array.from(farm.runtimeFarmWastelandPlotIds(stored)), [])
  const news = await farm.farmNews()
  assert.deepEqual(JSON.parse(JSON.stringify(news)), { ripe: 1, pests: 1 })
  assert.deepEqual(writes, [])
  assert.equal(farm.save.saveJsonData.farm, stored)
})

test('runtime farmNews derives ripeness from canonical progress and the projection clock, not wall time', async () => {
  const wallNow = Math.floor(Date.now() / 1000)
  const gameNow = wallNow - 200_000
  const stored = JSON.stringify({
    experience: 10,
    rank: 2,
    weather: 'Sunny',
    // If wall time were authoritative, this newly sown plot would be ripe.
    // Canonical progress says it is still growing, and the projection clock agrees.
    farmland: [
      { farmland: 'FarmlandS', crop: 'RadishSeed', time: gameNow - 10, state: 0, progress: 10 / 50400 },
      // No progress/state on an imported land: its age may only use projection game time.
      { farmland: 'FarmlandS', crop: 'RadishSeed', time: gameNow - 50400 },
    ],
  })
  const writes = []
  const farm = loadFarm({
    runtimeProjectionMode: true,
    info: { yb: 500, name: 'pet' },
    save: { saveJsonData: { farm: stored }, petInfo: { yb: 500, name: 'pet' } },
    currentProjectionView: () => ({ gameTimeMs: gameNow * 1000, timeZone: 'UTC' }),
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
    phoneUI: () => false,
    openBox: () => () => {},
    SwfPlayer: class {},
    window: { qqpet: { setFocusable: () => {} } },
  }, 'farmNews, save')
  assert.deepEqual(JSON.parse(JSON.stringify(await farm.farmNews())), { ripe: 1, pests: 0 })
  assert.deepEqual(writes, [])
  assert.equal(farm.save.saveJsonData.farm, stored)
})

test('runtime farmNews does not let stale age override contradictory canonical maturity fields', async () => {
  const gameNow = Math.floor(Date.now() / 1000)
  const stored = JSON.stringify({
    experience: 10,
    rank: 2,
    weather: 'Sunny',
    farmland: [
      { farmland: 'FarmlandS', crop: 'RadishSeed', time: gameNow - 200_000, state: 4, progress: 0.9 },
      { farmland: 'FarmlandS', crop: 'RadishSeed', time: gameNow - 200_000, state: 0, progress: 0.1 },
    ],
  })
  const writes = []
  const farm = loadFarm({
    runtimeProjectionMode: true,
    info: { yb: 500, name: 'pet' },
    save: { saveJsonData: { farm: stored }, petInfo: { yb: 500, name: 'pet' } },
    currentProjectionView: () => ({ gameTimeMs: gameNow * 1000, timeZone: 'UTC' }),
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
    phoneUI: () => false,
    openBox: () => () => {},
    SwfPlayer: class {},
    window: { qqpet: { setFocusable: () => {} } },
  }, 'farmNews, save')
  assert.deepEqual(JSON.parse(JSON.stringify(await farm.farmNews())), { ripe: 0, pests: 0 })
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
    currentProjectionView: () => ({ gameTimeMs: 1_700_000_000_000, timeZone: 'UTC' }),
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
    phoneUI: () => false,
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

function mountRuntimeFarm(stored, dispatch = async () => ({ status: 'applied' })) {
  const info = { yb: 500, name: 'pet' }
  const calls = []
  const writes = []
  let content = null
  let projectionListener = null
  const farm = loadFarm({
    runtimeProjectionMode: true,
    info,
    save: { saveJsonData: { farm: stored }, petInfo: { yb: 500, name: 'pet' } },
    currentProjectionView: () => ({ gameTimeMs: 1_700_000_000_000, timeZone: 'UTC' }),
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
    dispatchRuntimeCommand: (command) => {
      calls.push(command)
      return dispatch(command)
    },
    commandSucceeded: (result) => result?.status === 'applied',
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
    phoneUI: () => false,
    openBox: (value) => { content = value; return () => {} },
    SwfPlayer: class {},
    window: { qqpet: { setFocusable: () => {} } },
  }, 'openFarm, save, runtimeFarmPlotLabels, runtimeFarmWastelandPlotIds')
  farm.openFarm()
  assert.ok(content !== null)
  return {
    farm,
    info,
    calls,
    writes,
    get content() { return content },
    projectionApplied() { projectionListener?.() },
  }
}

test('short imported farmland keeps missing indices non-actionable and out of reclaim', async () => {
  const stored = JSON.stringify({
    experience: '1', rank: '01', weather: 'Sunny', burden: [], warehouse: [],
    farmland: [
      { farmland: 'FarmlandS' },
      { farmland: 'Wasteland' },
    ],
  })
  const mounted = mountRuntimeFarm(stored)
  assert.deepEqual(Array.from(mounted.farm.runtimeFarmWastelandPlotIds(stored)), [1])
  assert.equal(findButton(mounted.content, '7 荒地'), null)
  assert.match(nodeText(mounted.content), /3 未导入/)
  const reclaimable = findButton(mounted.content, '2 荒地')
  assert.ok(reclaimable)
  reclaimable.click()
  findButton(mounted.content, '开垦荒地').click()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(JSON.parse(JSON.stringify(mounted.calls)), [
    { type: 'farm.reclaim', payload: { plotIds: [1] } },
  ])
  assert.deepEqual(mounted.writes, [])
})

test('oversized imported farmland is bounded to the canonical 18 plots in projection and UI', async () => {
  const stored = JSON.stringify({
    experience: '1', rank: '01', weather: 'Sunny', burden: [], warehouse: [],
    farmland: Array.from({ length: 24 }, (_, index) => ({ farmland: index < 6 ? 'FarmlandS' : 'Wasteland' })),
  })
  const labels = loadFarm({
    runtimeProjectionMode: true,
    save: { saveJsonData: { farm: stored } },
    location: { hostname: 'test' },
    localStorage: { getItem: () => null, setItem: () => {} },
    registerProjectionCacheInvalidator: () => {},
    FARM,
  }, 'runtimeFarmPlotLabels, runtimeFarmWastelandPlotIds')
  assert.equal(labels.runtimeFarmPlotLabels(stored).length, 18)
  assert.deepEqual(Array.from(labels.runtimeFarmWastelandPlotIds(stored)), Array.from({ length: 12 }, (_, index) => index + 6))

  const mounted = mountRuntimeFarm(stored)
  assert.ok(findButton(mounted.content, '18 荒地'))
  assert.equal(findButton(mounted.content, '19 荒地'), null)
  assert.doesNotMatch(nodeText(mounted.content), /\b19 荒地\b/)
  assert.deepEqual(mounted.writes, [])
})

test('runtime fertilize dispatches selected growing plots and renders authoritative info.yb wealth', async () => {
  const stored = JSON.stringify({
    experience: 10, rank: 2, wealth: 999, weather: 'Sunny', burden: [], warehouse: [],
    farmland: [
      { farmland: 'FarmlandS', crop: 'RadishSeed', time: 1_700_000_000, state: 2, progress: 0.6 },
      { farmland: 'FarmlandS', crop: 'CarrotSeed', time: 1_700_000_000, state: 1, progress: 0.3 },
      { farmland: 'FarmlandS' },
    ],
  })
  const mounted = mountRuntimeFarm(stored)
  assert.match(nodeText(mounted.content.children[0]), /元宝500/)
  assert.doesNotMatch(nodeText(mounted.content.children[0]), /元宝999/)

  // A wealth-only projection must update the open panel from authoritative info,
  // even while the farm blob still carries its stale legacy wealth field.
  mounted.info.yb = 777
  mounted.projectionApplied()
  assert.match(nodeText(mounted.content.children[0]), /元宝777/)
  assert.doesNotMatch(nodeText(mounted.content.children[0]), /元宝999/)

  findButton(mounted.content, '1 白萝卜 60%').click()
  findButton(mounted.content, '2 胡萝卜 30%').click()
  findButton(mounted.content, '施肥').click()
  await Promise.resolve()
  await Promise.resolve()

  assert.deepEqual(
    JSON.parse(JSON.stringify(mounted.calls)),
    [{ type: 'farm.care', payload: { plotIds: [0, 1], action: 'fertilize' } }],
  )
  assert.match(nodeText(mounted.content), /施肥完成/)
  assert.deepEqual(mounted.writes, [])
})

test('fresh runtime farm UI can acquire fertilizer before fertilizing', async () => {
  const mounted = mountRuntimeFarm(undefined)
  const buy = findButton(mounted.content, '买1肥料')
  assert.ok(buy)
  buy.click()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(JSON.parse(JSON.stringify(mounted.calls)), [
    { type: 'farm.buyFertilizer', payload: { fertilizerId: 'Fertilizer', quantity: 1 } },
  ])
  assert.match(nodeText(mounted.content), /购买肥料成功/)
})

test('runtime farm failure keeps exactly one global error surface and no inline duplicate', async () => {
  const stored = JSON.stringify({
    experience: 10, rank: 2, wealth: 999, weather: 'Sunny', burden: [], warehouse: [],
    farmland: [{ farmland: 'FarmlandS', crop: 'RadishSeed', time: 1_700_000_000, state: 2, progress: 0.6 }],
  })
  const errorText = '背包里的物品不足'
  const globalSurfaces = []
  const mounted = mountRuntimeFarm(stored, async () => {
    // dispatchRuntimeCommand emits this single shared surface for a rejected command.
    globalSurfaces.push({ type: 'qqpet-command-error', code: 'insufficient_item', message: errorText })
    return { status: 'rejected', error: { code: 'insufficient_item', message: errorText } }
  })

  findButton(mounted.content, '1 白萝卜 60%').click()
  findButton(mounted.content, '施肥').click()
  await Promise.resolve()
  await Promise.resolve()

  const inlineDuplicate = nodeText(mounted.content).includes(errorText)
  const surfaces = globalSurfaces.length + (inlineDuplicate ? 1 : 0)
  assert.equal(globalSurfaces.length, 1)
  assert.equal(inlineDuplicate, false)
  assert.equal(surfaces, 1)
  assert.doesNotMatch(nodeText(mounted.content), /施肥完成/)
})

test('runtime farm rejection replaces a previous inline success message', async () => {
  const stored = JSON.stringify({
    experience: 10, rank: 2, weather: 'Sunny', burden: [], warehouse: [],
    farmland: [{ farmland: 'FarmlandS', crop: 'RadishSeed', time: 1_700_000_000, state: 2, progress: 0.6 }],
  })
  let attempt = 0
  const globalSurfaces = []
  const mounted = mountRuntimeFarm(stored, async () => {
    attempt++
    if (attempt === 1) return { status: 'applied' }
    const error = { code: 'insufficient_item', message: '背包里的物品不足' }
    globalSurfaces.push({ type: 'qqpet-command-error', ...error })
    return { status: 'rejected', error }
  })

  findButton(mounted.content, '1 白萝卜 60%').click()
  findButton(mounted.content, '施肥').click()
  await Promise.resolve()
  await Promise.resolve()
  assert.match(nodeText(mounted.content), /施肥完成/)

  findButton(mounted.content, '施肥').click()
  await Promise.resolve()
  await Promise.resolve()
  assert.doesNotMatch(nodeText(mounted.content), /施肥完成/)
  assert.equal(globalSurfaces.length, 1)
  assert.doesNotMatch(nodeText(mounted.content), /背包里的物品不足/)
})

test('runtime farm branch dispatches only commands and leaves the SWF path intact', () => {
  const source = readFileSync(new URL('../../src/renderer/ui/farm.ts', import.meta.url), 'utf8')
  const runtimeStart = source.indexOf('function openRuntimeFarm')
  const runtimeEnd = source.indexOf('\nfunction fresh', runtimeStart)
  assert.ok(runtimeStart >= 0 && runtimeEnd > runtimeStart)
  const runtimeBody = source.slice(runtimeStart, runtimeEnd)
  for (const call of ['farmBuySeed', 'farmBuyFertilizer', 'farmReclaim', 'farmPlant', 'farmCare', 'farmHarvest', 'farmClear', 'farmSellProduce']) {
    assert.match(runtimeBody, new RegExp('uiCommands\\.' + call))
  }
  assert.match(runtimeBody, /farmCare\(chosen\(\), 'fertilize'\)/)
  assert.match(runtimeBody, /元宝\$\{info\.yb\}/)
  assert.doesNotMatch(runtimeBody, /state\.wealth/)
  assert.doesNotMatch(runtimeBody, /commandErrorText|result\.status === 'rejected'/)
  assert.doesNotMatch(runtimeBody, /\b(update|setInfo|writeSol)\s*\(/)
  const openFarmBody = source.slice(source.indexOf('export function openFarm'), source.indexOf("registerProjectionCacheInvalidator('farm'"))
  assert.match(openFarmBody, /player\.load\('pet\/qqfarm\/Farm\.swf'/)
  assert.match(openFarmBody, /writeSol\(KEY/)
  const newsBody = source.slice(source.indexOf('export async function farmNews'), source.indexOf('ripening ??= ripeTimes()'))
  assert.match(newsBody, /currentProjectionView\(\)/)
  assert.match(newsBody, /land\.state/)
  assert.match(newsBody, /land\.progress/)
  assert.doesNotMatch(newsBody, /Date\.now\(\)/)
  assert.doesNotMatch(newsBody, /update\('saveJsonData'/)
})

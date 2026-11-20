import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const { uiCommands } = await import('../../src/renderer/pet/command-map.ts')
const { projectIslandQuizSession } = await import('../../src/shared/sync/session-projection.ts')

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

const ISLAND = {
  places: { '3': '夏帕海岸', '13': '百货店', '22': '风语广场' },
  folk: {
    莉莉: { key: 'npc_lili', scene: 3, about: '在海边长大的小姑娘' },
    周大饼: { key: 'npc_zhoudabing', scene: 13, about: '百货店老板' },
    智慧长老: { key: 'npc_xogame', scene: 22, about: '学问渊博' },
  },
  senders: ['小艾', '图图'],
  letters: 5,
  pieces: 8,
  tier: 4,
  facts: [['布袋长老招信使', '今天有信要送。']],
  errands: [['佐佐', 'bring', '102010015', '带一杯咖啡']],
  monsters: { '1': { name: '狗妖', scene: 30, about: '最弱的小妖' } },
  tactics: { 硬拼: 'strong', 智取: 'intel', 说服: 'charm' },
  spots: { jycat: { name: '监狱猫' } },
  plays: { QQ跆拳道: '跆拳道' },
  chores: { Work: 2 },
  gifts: { food: '好吃的', toy: '好玩的玩具', clean: '清洁用品' },
}

const BASE_ISLAND = {
  day: 86_400,
  sent: 1,
  letter: '',
  lit: ['周大饼'],
  lamps: [13],
  tier: 1,
  pieces: 3,
  piece: false,
  want: '102010001',
  loved: false,
  errands: [
    { from: '智慧长老', kind: 'quiz', to: 'dx-chinese', got: 0, took: false },
    { from: '翠花', kind: 'talk', to: '周大饼', got: 0, took: false },
    { from: '佐佐', kind: 'bring', to: '102010015', got: 0, took: false },
  ],
  fought: ['1'],
  wins: 4,
  newsFacts: [['布袋长老招信使', '今天有信要送。']],
  newsDay: 86_400,
}

const GOODS = {
  '102010001': { id: '102010001', type: 'food', name: '圈圈冰激凌', num: 1, url: '' },
  '102010015': { id: '102010015', type: 'food', name: '下岛咖啡', num: 1, url: '' },
  '102020003': { id: '102020003', type: 'toy', name: '橡胶球', num: 1, url: '' },
}

function findGood(id) {
  return GOODS[id] ?? null
}

function parseGoodCode(entry) {
  if (entry.startsWith('_') === false) return null
  const [id, rawCount] = entry.slice(1).split('*')
  const good = findGood(id)
  if (good === null) return null
  const num = rawCount === undefined ? 1 : Number(rawCount)
  return Number.isSafeInteger(num) && num > 0 ? { ...good, num } : null
}

function projectionSave(island = BASE_ISLAND) {
  return {
    saveJsonData: { island: JSON.stringify(island) },
    selfGoodDatas: {
      food: ['_102010001*2', '_102010015*1'],
      toy: ['_102020003*1'],
      clean: [],
      medicine: ['_103010001*1'],
      background: [],
      nums: [],
      service: [],
      work: [],
      study: [],
      trip: [],
    },
  }
}

class FakeNode {
  constructor(className = '', children = []) {
    this.className = className
    this.children = []
    this.listeners = new Map()
    this.style = {}
    this.dataset = {}
    this.attributes = new Map()
    for (const child of children) this.append(child)
  }
  append(...nodes) {
    for (const node of nodes) this.children.push(typeof node === 'string' ? String(node) : node)
  }
  replaceChildren(...nodes) {
    this.children = []
    this.append(...nodes)
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }
  setAttribute(key, value) {
    this.attributes.set(key, String(value))
  }
  getAttribute(key) {
    return this.attributes.get(key) ?? null
  }
  removeEventListener(type, listener) {
    const listeners = (this.listeners.get(type) ?? []).filter((entry) => entry !== listener)
    this.listeners.set(type, listeners)
  }
  click() {
    for (const listener of this.listeners.get('click') ?? []) listener({ type: 'click', target: this, stopPropagation() {}, preventDefault() {} })
  }
  get textContent() {
    return this.children.map((child) => (typeof child === 'string' ? child : child.textContent)).join('')
  }
}

function nodesUnder(root, predicate) {
  const found = []
  const visit = (node) => {
    if (node instanceof FakeNode === false) return
    if (predicate(node)) found.push(node)
    for (const child of node.children) visit(child)
  }
  visit(root)
  return found
}

function buttonsIn(root) {
  return nodesUnder(root, (node) => node.listeners.has('click'))
}

function buttonWithText(root, text) {
  return buttonsIn(root).find((button) => button.textContent.trim() === text) ?? null
}

function rowWithHeading(root, heading) {
  return nodesUnder(root, (node) =>
    node.className === 'i_row' && node.children.some((child) => child instanceof FakeNode && child.className === 'i_head' && child.textContent.trim() === heading),
  )[0] ?? null
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function mountIsland(options = {}) {
  const save = options.save ?? projectionSave()
  const dispatches = []
  const writes = []
  const logs = []
  const opened = []
  const sheets = []
  const windowEvents = []
  let projectionListener = null
  let storeEventListener = null
  const windowObj = {
    __qqpetRuntimeV2: true,
    qqpet: {
      command: (command) => {
        dispatches.push(command)
        const result = command.type === 'island.startQuiz'
          ? options.startQuizResult ?? {
              sessionToken: 'quiz-token',
              recordId: 'dx-chinese:0',
              quizKind: 'dx-chinese',
              prompt: '请选择正确答案',
              options: ['甲', '乙', '丙'],
              answerIndex: 1,
              answerKey: '乙',
            }
          : {}
        return Promise.resolve({ status: 'applied', commandType: command.type, opId: 'op-' + dispatches.length, commandSeq: dispatches.length, revision: dispatches.length, eventSeq: dispatches.length, result })
      },
      save: (patch) => writes.push(['window.save', patch]),
    },
    dispatchEvent: (event) => { windowEvents.push(event); return true },
  }
  const runtimeCommand = loadConverted('../../src/renderer/pet/runtime-command.ts', {
    window: windowObj,
    goodOf: () => { throw new Error('runtime-command must not need goodOf for these commands') },
  }, 'dispatchRuntimeCommand, commandSucceeded, commandErrorText, commandResultData')
  const island = loadConverted('../../src/renderer/ui/island-runtime.ts', {
    window: windowObj,
    save,
    uiCommands,
    currentProjectionView: () => options.view ?? { gameTimeMs: 86_400_000, timeZone: 'Asia/Shanghai' },
    onProjectionApplied: (listener) => { projectionListener = listener; return () => { projectionListener = null } },
    onStoreEvent: (listener) => { storeEventListener = listener; return () => { storeEventListener = null } },
    registerProjectionCacheInvalidator: () => () => {},
    update: (...args) => writes.push(['update', ...args]),
    setInfo: (...args) => writes.push(['setInfo', ...args]),
    takeGood: (...args) => writes.push(['takeGood', ...args]),
    grantGoods: (...args) => writes.push(['grantGoods', ...args]),
    writeIsland: (...args) => writes.push(['writeIsland', ...args]),
    ISLAND,
    findGood,
    parseGoodCode,
    dayKeyAt: (ms, timeZone) => timeZone === 'Asia/Shanghai' ? '2026-10-21' : '1970-01-01',
    div: (className, ...children) => new FakeNode(className, children),
    button: (className, run, ...children) => {
      const node = new FakeNode(className, children)
      node.addEventListener('click', run)
      return node
    },
    openBox: (content, opts) => {
      opened.push(content)
      return () => { opts?.onClose?.() }
    },
    phoneUI: () => options.phone === true,
    openSheet: (sheet) => {
      sheets.push(sheet)
      const handle = {
        el: new FakeNode('qp-sheet'),
        card: new FakeNode('qp-sheet-card'),
        body: sheet.body,
        title: new FakeNode('qp-sheet-title'),
        close: () => {
          sheet.closed = true
          sheet.onClose?.()
        },
      }
      return handle
    },
    openShop: () => opened.push('shop'),
    openGames: () => opened.push('games'),
    console: { log: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')) },
    ...runtimeCommand,
  }, 'readIslandProjection, islandCommands, dispatchIsland, selectGiftItems, setQuizProjection, quizState, openIslandRuntime')
  return {
    island,
    save,
    dispatches,
    writes,
    logs,
    opened,
    sheets,
    windowEvents,
    fireProjection: () => projectionListener?.({ gameTimeMs: 86_400_000, timeZone: 'Asia/Shanghai' }, []),
    fireEvent: (event) => storeEventListener?.(event),
  }
}

test('all island intents use the exact semantic command keys and payloads', () => {
  assert.deepEqual(uiCommands.islandArriveScene('22'), { type: 'island.arriveScene', payload: { sceneId: '22' } })
  assert.deepEqual(uiCommands.islandAcceptLetter('小艾', '莉莉'), {
    type: 'island.acceptLetter',
    payload: { fromNpcId: '小艾', toNpcId: '莉莉' },
  })
  assert.deepEqual(uiCommands.islandDeliverLetter('莉莉'), { type: 'island.deliverLetter', payload: { toNpcId: '莉莉' } })
  assert.deepEqual(uiCommands.islandTurnInErrand('佐佐', '2', '102010015'), {
    type: 'island.turnInErrand',
    payload: { npcId: '佐佐', errandId: '2', itemId: '102010015' },
  })
  assert.deepEqual(uiCommands.islandTurnInErrand('翠花', '1'), {
    type: 'island.turnInErrand',
    payload: { npcId: '翠花', errandId: '1' },
  })
  assert.deepEqual(uiCommands.islandStartQuiz('智慧长老', '0'), {
    type: 'island.startQuiz',
    payload: { npcId: '智慧长老', errandId: '0' },
  })
  assert.deepEqual(uiCommands.islandAnswerQuiz('quiz-token', 2), {
    type: 'island.answerQuiz',
    payload: { sessionToken: 'quiz-token', optionIndex: 2 },
  })
  assert.deepEqual(uiCommands.islandFightMonster('1', '硬拼'), {
    type: 'island.fightMonster',
    payload: { monsterId: '1', tactic: '硬拼' },
  })
  assert.deepEqual(uiCommands.islandClaimGrowthReward(), { type: 'island.claimGrowthReward', payload: {} })
  assert.deepEqual(uiCommands.islandClaimTreasure(), { type: 'island.claimTreasure', payload: {} })
  assert.deepEqual(uiCommands.islandGiftNpc('小艾', '102010001'), {
    type: 'island.giftNpc',
    payload: { npcId: '小艾', itemId: '102010001' },
  })
  assert.deepEqual(uiCommands.islandTalkNpc('周大饼'), { type: 'island.talkNpc', payload: { npcId: '周大饼' } })
  assert.deepEqual(uiCommands.islandVisitSpot('jycat'), { type: 'island.visitSpot', payload: { spotId: 'jycat' } })
  assert.deepEqual(uiCommands.islandChat('周大饼'), { type: 'island.chat', payload: { npcId: '周大饼' } })
  assert.deepEqual(uiCommands.islandPlayGame('QQ跆拳道'), { type: 'island.playGame', payload: { gameKey: 'QQ跆拳道' } })
  assert.deepEqual(uiCommands.islandRefreshNews('2026-10-21'), {
    type: 'island.refreshNews',
    payload: { dayKey: '2026-10-21' },
  })
})

test('runtime island dispatches all fifteen commands through window.qqpet.command without any canonical write', async () => {
  const { island, dispatches, writes } = mountIsland()
  const commands = [
    island.islandCommands.arriveScene('22'),
    island.islandCommands.acceptLetter('小艾', '莉莉'),
    island.islandCommands.deliverLetter('莉莉'),
    island.islandCommands.turnInErrand('佐佐', '2', '102010015'),
    island.islandCommands.startQuiz('智慧长老', '0'),
    island.islandCommands.answerQuiz('quiz-token', 2),
    island.islandCommands.fightMonster('1', '硬拼'),
    island.islandCommands.claimGrowthReward(),
    island.islandCommands.claimTreasure(),
    island.islandCommands.giftNpc('小艾', '102010001'),
    island.islandCommands.talkNpc('周大饼'),
    island.islandCommands.visitSpot('jycat'),
    island.islandCommands.chat('周大饼'),
    island.islandCommands.playGame('QQ跆拳道'),
    island.islandCommands.refreshNews('2026-10-21'),
  ]
  for (const command of commands) await island.dispatchIsland(command)
  assert.deepEqual(dispatches.map((command) => command.type), [
    'island.arriveScene',
    'island.acceptLetter',
    'island.deliverLetter',
    'island.turnInErrand',
    'island.startQuiz',
    'island.answerQuiz',
    'island.fightMonster',
    'island.claimGrowthReward',
    'island.claimTreasure',
    'island.giftNpc',
    'island.talkNpc',
    'island.visitSpot',
    'island.chat',
    'island.playGame',
    'island.refreshNews',
  ])
  assert.deepEqual(dispatches[3].payload, { npcId: '佐佐', errandId: '2', itemId: '102010015' })
  assert.deepEqual(writes, [], 'runtime island must not use update/setInfo/window.save')
})

test('quiz projection strips answer keys and answer dispatch carries only the session token', async () => {
  const { island, dispatches } = mountIsland()
  const canonicalPayload = {
    kind: 'island_quiz',
    quizKind: 'dx-chinese',
    recordId: 'dx-chinese:0',
    prompt: '请选择正确答案',
    options: ['甲', '乙', '丙'],
    answerIndex: 1,
    metadata: { npcId: '智慧长老', errandId: '0' },
  }
  const projected = projectIslandQuizSession({ sessionToken: 'quiz-token', payload: canonicalPayload })
  assert.deepEqual(Object.keys(projected).sort(), ['options', 'prompt', 'quizKind', 'recordId', 'sessionToken'])
  assert.equal(JSON.stringify(projected).includes('answer'), false)
  assert.equal(Object.hasOwn(projected, 'answerIndex'), false)

  const stored = island.setQuizProjection({ ...projected, answerIndex: 1, answerKey: '乙', metadata: canonicalPayload.metadata })
  assert.deepEqual(Object.keys(stored).sort(), ['options', 'prompt', 'quizKind', 'recordId', 'sessionToken'])
  assert.equal(JSON.stringify(island.quizState()).includes('answer'), false)
  assert.equal(island.setQuizProjection({ prompt: 'missing token', options: ['甲'] }), null)
  assert.equal(island.quizState(), null)

  await island.dispatchIsland(island.islandCommands.answerQuiz(stored.sessionToken, 1))
  assert.deepEqual(dispatches.at(-1), {
    type: 'island.answerQuiz',
    payload: { sessionToken: 'quiz-token', optionIndex: 1 },
  })
})

test('gifts come from owned projected inventory and exclude non-giftable types', () => {
  const { island, save } = mountIsland()
  const gifts = JSON.parse(JSON.stringify(island.selectGiftItems(save)))
  assert.deepEqual(gifts.map((gift) => [gift.id, gift.type, gift.num]), [
    ['102010001', 'food', 2],
    ['102010015', 'food', 1],
    ['102020003', 'toy', 1],
  ])
  assert.equal(gifts.some((gift) => gift.type === 'medicine'), false, 'medicine is not a giftable island item')
  save.selfGoodDatas.food = []
  assert.deepEqual(JSON.parse(JSON.stringify(island.selectGiftItems(save).map((gift) => gift.id))), ['102020003'])

  const empty = projectionSave()
  empty.selfGoodDatas.food = []
  empty.selfGoodDatas.toy = []
  empty.selfGoodDatas.clean = []
  assert.deepEqual(JSON.parse(JSON.stringify(island.selectGiftItems(empty))), [])

  const malformed = projectionSave()
  malformed.saveJsonData.island = '{broken'
  const state = island.readIslandProjection(malformed)
  assert.equal(state.letter, '')
  assert.equal(state.errands.length, 0)
  assert.equal(state.want, '')
})

test('the mounted runtime panel reads the projection, dispatches every interaction and re-renders after events', async () => {
  const { island, save, dispatches, writes, logs, opened, fireProjection } = mountIsland()
  island.openIslandRuntime()
  const root = opened[0]
  assert.ok(root, 'openIslandRuntime must mount a panel')
  assert.match(root.textContent, /企鹅岛/)
  assert.match(root.textContent, /布袋长老/)
  assert.match(root.textContent, /今日委托/)
  assert.match(root.textContent, /小艾的心愿/)
  assert.match(root.textContent, /岛上的妖怪/)
  assert.match(root.textContent, /探索地点/)
  assert.match(root.textContent, /岛民小游戏/)

  const sceneRow = rowWithHeading(root, '夏帕海岸')
  assert.ok(sceneRow, 'the projected scene list must render')
  buttonWithText(sceneRow, '前往').click()
  const npcRow = rowWithHeading(root, '莉莉')
  buttonWithText(npcRow, '交谈').click()
  buttonWithText(npcRow, '聊天').click()
  buttonWithText(root, '接信').click()
  buttonWithText(root, '领成长礼').click()
  buttonWithText(root, '领宝藏碎片').click()
  buttonWithText(root, '刷新新闻').click()
  buttonWithText(rowWithHeading(root, '狗妖'), '硬拼').click()
  buttonWithText(rowWithHeading(root, '监狱猫'), '查看').click()
  buttonWithText(rowWithHeading(root, '跆拳道'), '游玩').click()
  buttonWithText(root, '送给小艾').click()
  buttonWithText(rowWithHeading(root, '智慧长老 · quiz'), '答题').click()
  await flush()
  buttonWithText(rowWithHeading(root, '翠花 · talk'), '交付').click()
  buttonWithText(rowWithHeading(root, '佐佐 · bring'), '交付').click()
  await flush()

  const byType = (type) => dispatches.filter((command) => command.type === type)
  assert.deepEqual(byType('island.arriveScene')[0], { type: 'island.arriveScene', payload: { sceneId: '3' } })
  assert.deepEqual(byType('island.talkNpc')[0], { type: 'island.talkNpc', payload: { npcId: '莉莉' } })
  assert.deepEqual(byType('island.chat')[0], { type: 'island.chat', payload: { npcId: '莉莉' } })
  assert.deepEqual(byType('island.acceptLetter')[0], {
    type: 'island.acceptLetter',
    payload: { fromNpcId: '小艾', toNpcId: '莉莉' },
  })
  assert.deepEqual(byType('island.claimGrowthReward')[0], { type: 'island.claimGrowthReward', payload: {} })
  assert.deepEqual(byType('island.claimTreasure')[0], { type: 'island.claimTreasure', payload: {} })
  assert.deepEqual(byType('island.refreshNews')[0], {
    type: 'island.refreshNews',
    payload: { dayKey: '2026-10-21' },
  })
  assert.deepEqual(byType('island.fightMonster')[0], { type: 'island.fightMonster', payload: { monsterId: '1', tactic: '硬拼' } })
  assert.deepEqual(byType('island.visitSpot')[0], { type: 'island.visitSpot', payload: { spotId: 'jycat' } })
  assert.deepEqual(byType('island.playGame')[0], { type: 'island.playGame', payload: { gameKey: 'QQ跆拳道' } })
  assert.deepEqual(byType('island.giftNpc')[0], { type: 'island.giftNpc', payload: { npcId: '小艾', itemId: '102010001' } })
  assert.deepEqual(byType('island.startQuiz')[0], {
    type: 'island.startQuiz',
    payload: { npcId: '智慧长老', errandId: '0' },
  })
  assert.deepEqual(byType('island.turnInErrand')[0], {
    type: 'island.turnInErrand',
    payload: { npcId: '翠花', errandId: '1' },
  })
  assert.deepEqual(byType('island.turnInErrand')[1], {
    type: 'island.turnInErrand',
    payload: { npcId: '佐佐', errandId: '2', itemId: '102010015' },
  })

  // The startQuiz result carried answerIndex/answerKey; the panel may only show the public projection.
  assert.match(root.textContent, /请选择正确答案/)
  assert.match(root.textContent, /甲/)
  assert.doesNotMatch(root.textContent, /answer|answerIndex|answerKey/)
  assert.equal(JSON.stringify(dispatches).includes('answerIndex'), false)
  assert.equal(JSON.stringify(dispatches).includes('answerKey'), false)
  assert.equal(logs.join('\n').includes('answer'), false)

  const option = buttonWithText(root, '乙')
  assert.ok(option, 'the projected quiz options must be clickable')
  option.click()
  await flush()
  assert.deepEqual(byType('island.answerQuiz').at(-1), {
    type: 'island.answerQuiz',
    payload: { sessionToken: 'quiz-token', optionIndex: 1 },
  })
  assert.equal(root.textContent.includes('请选择正确答案'), false, 'an applied answer clears the question')

  // A projection refresh must redraw the same mounted panel from canonical save data.
  save.saveJsonData.island = JSON.stringify({ ...BASE_ISLAND, letter: '莉莉' })
  fireProjection()
  await flush()
  assert.match(root.textContent, /正在送信给 莉莉/)
  buttonWithText(root, '送达').click()
  assert.deepEqual(byType('island.deliverLetter').at(-1), {
    type: 'island.deliverLetter',
    payload: { toNpcId: '莉莉' },
  })
  assert.deepEqual(writes, [], 'mounted runtime island must not use update/setInfo/window.save')
})

test('a phone gets the same island as a bottom sheet: every command still reachable', async () => {
  const { island, dispatches, opened, sheets, fireProjection } = mountIsland({ phone: true })
  island.openIslandRuntime()
  assert.equal(opened.length, 0, 'a phone must not open the 580 px desktop window')
  assert.equal(sheets.length, 1, 'a phone mounts one bottom sheet')
  const sheet = sheets[0]
  assert.equal(sheet.title, '企鹅岛')
  assert.equal(sheet.cardClass, 'qp-island-sheet')
  assert.ok(sheet.footer, 'the five island actions live in the pinned footer')
  assert.equal(sheet.footer.className, 'qp-island-acts')

  const body = sheet.body
  for (const heading of ['布袋长老', '岛民与地点', '今日委托', '小艾的心愿', '今日新闻', '岛上的妖怪', '探索地点', '岛民小游戏']) {
    assert.match(body.textContent, new RegExp(heading), `the phone sheet lost the ${heading} section`)
  }
  // The same rows and the same commands as the desktop window, not a subset.
  assert.ok(rowWithHeading(body, '莉莉'), 'an islander row must render on the phone')
  buttonWithText(rowWithHeading(body, '莉莉'), '交谈').click()
  assert.deepEqual(dispatches.at(-1), { type: 'island.talkNpc', payload: { npcId: '莉莉' } })
  buttonWithText(rowWithHeading(body, '监狱猫'), '查看').click()
  assert.deepEqual(dispatches.at(-1), { type: 'island.visitSpot', payload: { spotId: 'jycat' } })

  const footer = sheet.footer
  for (const label of ['领成长礼', '领宝藏碎片', '刷新新闻', '去商店', '玩游戏']) {
    assert.ok(buttonWithText(footer, label), `the pinned footer lost ${label}`)
  }
  buttonWithText(footer, '领成长礼').click()
  assert.deepEqual(dispatches.at(-1), { type: 'island.claimGrowthReward', payload: {} })

  // A footer shortcut closes the sheet first; the target panel must still open.
  buttonWithText(footer, '去商店').click()
  assert.equal(sheet.closed, true, '去商店 must dismiss the island sheet')
  assert.deepEqual(opened, ['shop'])

  // The sheet redraws from the projection exactly like the desktop panel.
  fireProjection()
  await flush()
  assert.match(body.textContent, /布袋长老/)
})

test('runtime navigation exposes the converted island while the legacy island panel stays untouched', () => {
  const runtime = readFileSync(new URL('../../src/renderer/ui/island-runtime.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(runtime, /\bupdate\s*\(|\bsetInfo\s*\(|\btakeGood\s*\(|\bgrantGoods\s*\(|\bwriteIsland\s*\(/)
  assert.doesNotMatch(runtime, /window\.qqpet\.save|\banswerIndex\b|\banswerKey\b|\bconsole\.(log|error|warn)/)
  assert.match(runtime, /dispatchRuntimeCommand/)
  assert.match(runtime, /currentProjectionView/)

  const legacy = readFileSync(new URL('../../src/renderer/ui/island.ts', import.meta.url), 'utf8')
  assert.match(legacy, /const store = \(\): void => update\('saveJsonData', \{ island: JSON.stringify\(state\) \}\)/)
  assert.match(legacy, /import EXAM/)
  assert.match(legacy, /function quiz\(e: Errand\): void/)
  assert.match(legacy, /Math\.random/)

  const control = readFileSync(new URL('../../src/renderer/ui/control.ts', import.meta.url), 'utf8')
  assert.match(control, /import \{ openIslandRuntime \} from '\.\/island-runtime'/)
  assert.match(control, /runtimeProjectionMode/)
  assert.match(control, /child\.name === '社区' \? \{ \.\.\.child, name: '企鹅岛', run: openIslandRuntime \}/)
  assert.match(control, /child\.name === '池塘' \|\| child\.name === '游戏' \|\| child\.name === '企鹅岛'/)
  assert.match(control, /run: openIslandRuntime/)

  const runtimeMenu = readFileSync(new URL('../../src/renderer/ui/runtime-menu.ts', import.meta.url), 'utf8')
  assert.match(runtimeMenu, /openIsland: \(\) => void/)
  assert.match(runtimeMenu, /label: '企鹅岛', run: actions\.openIsland/)

  const menu = readFileSync(new URL('../../src/renderer/ui/menu.ts', import.meta.url), 'utf8')
  assert.match(menu, /import \{ openIslandRuntime \}/)
  assert.match(menu, /openIsland: openIslandRuntime/)
  assert.match(menu, /if \(runtimeProjectionMode\) \{/)
  assert.match(menu, /openFishing/)
})

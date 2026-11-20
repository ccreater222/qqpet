import { ISLAND, findGood, parseGoodCode } from '../../shared/pet-runtime/content'
import { dayKeyAt } from '../../shared/pet-runtime/time'
import type { IslandState } from '../../shared/pet-runtime/runtime-helpers'
import type { CommandResult, ResultDataMap } from '../../shared/sync/protocol'
import type { SaveData } from '../../shared/save'
import { uiCommands } from '../pet/command-map'
import { registerProjectionCacheInvalidator } from '../pet/projection-cache'
import { commandResultData, commandSucceeded, dispatchRuntimeCommand } from '../pet/runtime-command'
import { currentProjectionView, onProjectionApplied, onStoreEvent, save } from '../pet/store'
import { openBox } from './box'
import './css/island.css'
import './css/phone-pages.css'
import { button, div } from './dom'
import { openGames } from './games'
import { openSheet, type SheetHandle } from './mobile/sheet'
import { phoneUI } from './mobile/sizing'
import { openShop } from './shop'

export type RuntimeIslandQuiz = ResultDataMap['island.startQuiz']

const EMPTY_ISLAND: IslandState = {
  day: 0,
  sent: 0,
  letter: '',
  lit: [],
  lamps: [],
  tier: 0,
  pieces: 0,
  piece: false,
  want: '',
  loved: false,
  errands: [],
  fought: [],
  wins: 0,
  newsFacts: [],
  newsDay: 0,
}

/** Parses the projection-fed canonical island blob; malformed JSON degrades to the empty day. */
function islandOf(source: Pick<SaveData, 'saveJsonData'>): IslandState {
  try {
    const parsed = JSON.parse(source.saveJsonData.island || '{}') as Partial<IslandState>
    return {
      day: parsed.day ?? EMPTY_ISLAND.day,
      sent: parsed.sent ?? EMPTY_ISLAND.sent,
      letter: parsed.letter ?? EMPTY_ISLAND.letter,
      lit: parsed.lit ?? EMPTY_ISLAND.lit,
      lamps: parsed.lamps ?? EMPTY_ISLAND.lamps,
      tier: parsed.tier ?? EMPTY_ISLAND.tier,
      pieces: parsed.pieces ?? EMPTY_ISLAND.pieces,
      piece: parsed.piece ?? EMPTY_ISLAND.piece,
      want: parsed.want ?? EMPTY_ISLAND.want,
      loved: parsed.loved ?? EMPTY_ISLAND.loved,
      errands: parsed.errands ?? EMPTY_ISLAND.errands,
      fought: parsed.fought ?? EMPTY_ISLAND.fought,
      wins: parsed.wins ?? EMPTY_ISLAND.wins,
      newsFacts: parsed.newsFacts ?? EMPTY_ISLAND.newsFacts,
      newsDay: parsed.newsDay ?? EMPTY_ISLAND.newsDay,
    }
  } catch {
    return { ...EMPTY_ISLAND, lit: [], lamps: [], errands: [], fought: [], newsFacts: [] }
  }
}

export const readIslandProjection = islandOf

export const islandCommands = {
  arriveScene: uiCommands.islandArriveScene,
  acceptLetter: uiCommands.islandAcceptLetter,
  deliverLetter: uiCommands.islandDeliverLetter,
  turnInErrand: uiCommands.islandTurnInErrand,
  startQuiz: uiCommands.islandStartQuiz,
  answerQuiz: uiCommands.islandAnswerQuiz,
  fightMonster: uiCommands.islandFightMonster,
  claimGrowthReward: uiCommands.islandClaimGrowthReward,
  claimTreasure: uiCommands.islandClaimTreasure,
  giftNpc: uiCommands.islandGiftNpc,
  talkNpc: uiCommands.islandTalkNpc,
  visitSpot: uiCommands.islandVisitSpot,
  chat: uiCommands.islandChat,
  playGame: uiCommands.islandPlayGame,
  refreshNews: uiCommands.islandRefreshNews,
} as const

export type RuntimeIslandCommand = ReturnType<(typeof islandCommands)[keyof typeof islandCommands]>

const QUIZ_KEYS = ['sessionToken', 'recordId', 'quizKind', 'prompt', 'options'] as const

/**
 * The only quiz shape the panel ever holds: a fresh object with the public
 * projection fields. Canonical session-only fields are dropped.
 */
export function projectIslandQuiz(value: unknown): RuntimeIslandQuiz | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (QUIZ_KEYS.every((key) => Object.prototype.hasOwnProperty.call(record, key)) === false) return null
  if (
    typeof record.sessionToken !== 'string' ||
    typeof record.recordId !== 'string' ||
    typeof record.quizKind !== 'string' ||
    typeof record.prompt !== 'string' ||
    Array.isArray(record.options) === false ||
    record.options.every((option) => typeof option === 'string') === false
  ) return null
  return {
    sessionToken: record.sessionToken,
    recordId: record.recordId,
    quizKind: record.quizKind,
    prompt: record.prompt,
    options: [...record.options] as string[],
  }
}

let currentQuiz: RuntimeIslandQuiz | null = null

/** Stores a filtered copy of the startQuiz result; null clears the open question. */
export function setQuizProjection(value: unknown): RuntimeIslandQuiz | null {
  currentQuiz = projectIslandQuiz(value)
  return currentQuiz
}

/** A copy of the current public quiz projection, never the canonical session payload. */
export function quizState(): RuntimeIslandQuiz | null {
  return currentQuiz === null ? null : projectIslandQuiz(currentQuiz)
}

const GIFT_TYPES = ['food', 'toy', 'clean'] as const
type GiftType = (typeof GIFT_TYPES)[number]

export interface GiftItem {
  id: string
  type: GiftType
  name: string
  num: number
}

function giftTypeOf(type: string): GiftType | null {
  return (GIFT_TYPES as readonly string[]).includes(type) ? type as GiftType : null
}

function parseGift(entry: string): GiftItem | null {
  const good = parseGoodCode(entry)
  if (good === null) return null
  const type = giftTypeOf(good.type)
  return type === null || good.num <= 0 ? null : { id: good.id, type, name: good.name, num: good.num }
}

/** Owned inventory items the island accepts as gifts (food/toy/clean), projected only. */
export function selectGiftItems(source: Pick<SaveData, 'selfGoodDatas'>): GiftItem[] {
  const items: GiftItem[] = []
  for (const type of GIFT_TYPES) {
    for (const entry of source.selfGoodDatas[type] ?? []) {
      const item = parseGift(entry)
      if (item !== null && items.some((candidate) => candidate.id === item.id) === false) items.push(item)
    }
  }
  return items
}

export async function dispatchIsland<K extends RuntimeIslandCommand['type']>(
  command: Extract<RuntimeIslandCommand, { type: K }>,
): Promise<CommandResult<K> | null> {
  return dispatchRuntimeCommand(command)
}

interface IslandViewState {
  gameTimeMs: number
  timeZone: string
}

const renderListeners = new Set<() => void>()

function notifyRender(): void {
  for (const listener of renderListeners) listener()
}

let renderScheduled = false

/** Coalesces the projection plus its ordered events into one panel redraw. */
function scheduleRender(): void {
  if (renderScheduled) return
  renderScheduled = true
  void Promise.resolve().then(() => {
    renderScheduled = false
    notifyRender()
  })
}

function onRender(listener: () => void): () => void {
  renderListeners.add(listener)
  return () => { renderListeners.delete(listener) }
}

function viewState(): IslandViewState {
  return currentProjectionView() ?? { gameTimeMs: Date.now(), timeZone: 'UTC' }
}

onProjectionApplied(scheduleRender)
onStoreEvent(scheduleRender)
registerProjectionCacheInvalidator('island', scheduleRender)

function row(heading: string, detail: string, action?: HTMLElement): HTMLElement {
  return div('i_row', div('i_head', heading), detail.length > 0 ? div('i_line', detail) : '', ...(action === undefined ? [] : [action]))
}

function action(label: string, run: () => void): HTMLElement {
  const el = button('focusPress', run, label)
  el.setAttribute('role', 'button')
  return el
}

function commandButton(label: string, command: RuntimeIslandCommand): HTMLElement {
  return action(label, () => { void dispatchIsland(command) })
}

async function startQuiz(npcId: string, errandId: string): Promise<void> {
  const result = await dispatchIsland(islandCommands.startQuiz(npcId, errandId))
  const quiz = commandResultData<RuntimeIslandQuiz>(result)
  if (quiz !== null) {
    setQuizProjection(quiz)
    notifyRender()
  }
}

async function answerQuiz(sessionToken: string, optionIndex: number): Promise<void> {
  const result = await dispatchIsland(islandCommands.answerQuiz(sessionToken, optionIndex))
  if (commandSucceeded(result)) {
    setQuizProjection(null)
    notifyRender()
  }
}

function refreshNews(): void {
  const view = viewState()
  void dispatchIsland(islandCommands.refreshNews(dayKeyAt(view.gameTimeMs, view.timeZone)))
}

let open = false
/** Closes this surface: the desktop frame's remove, or the phone sheet's close. */
let closePanel: (() => void) | null = null
let offRender: (() => void) | null = null

function finishClose(): void {
  if (open === false) return
  open = false
  offRender?.()
  offRender = null
  closePanel = null
}

function close(): void {
  const hide = closePanel
  finishClose()
  hide?.()
}

/**
 * Fills one body/actions pair from the projection. The desktop window and the
 * phone sheet share this renderer: only the containers and their CSS differ, so
 * an island command cannot be reachable on one surface and missing on the other.
 */
function renderIsland(body: HTMLElement, acts: HTMLElement): void {
  const island = readIslandProjection(save)
  const gifts = selectGiftItems(save)
  const want = island.want.length > 0 ? findGood(island.want) : null
  const wantedGift = want === null ? null : gifts.find((gift) => gift.id === want.id) ?? null
  const firstUnlit = Object.keys(ISLAND.folk).find((name) => island.lit.includes(name) === false) ?? Object.keys(ISLAND.folk)[0] ?? ''
  const letterFull = island.sent >= ISLAND.letters
  const news = island.newsFacts.map(([heading, fact]) => row(heading, fact))
  const scenes = Object.entries(ISLAND.places).map(([id, name]) =>
    row(name, '', commandButton('前往', islandCommands.arriveScene(id))),
  )
  const npcs = Object.entries(ISLAND.folk).map(([id, npc]) =>
    row(
      id,
      (ISLAND.places[String(npc.scene)] ?? '未知地点') + ' · ' + npc.about,
      div(
        'i_acts',
        commandButton('交谈', islandCommands.talkNpc(id)),
        commandButton('聊天', islandCommands.chat(id)),
      ),
    ),
  )
  const monsters = Object.entries(ISLAND.monsters).map(([id, monster]) =>
    row(
      monster.name,
      monster.about,
      div(
        'i_acts',
        ...Object.keys(ISLAND.tactics).map((tactic) => commandButton(tactic, islandCommands.fightMonster(id, tactic))),
      ),
    ),
  )
  const spots = Object.entries(ISLAND.spots).map(([id, spot]) =>
    row(spot.name, '', commandButton('查看', islandCommands.visitSpot(id))),
  )
  const plays = Object.entries(ISLAND.plays).map(([key, name]) =>
    row(name, '', commandButton('游玩', islandCommands.playGame(key))),
  )
  const errands = island.errands.map((errand, index) =>
    row(
      errand.from + ' · ' + errand.kind,
      errand.to + (errand.took ? '（已完成）' : ''),
      errand.took
        ? undefined
        : action(errand.kind === 'quiz' ? '答题' : '交付', () => {
            if (errand.kind === 'quiz') {
              void startQuiz(errand.from, String(index))
              return
            }
            void dispatchIsland(islandCommands.turnInErrand(errand.from, String(index), errand.kind === 'bring' ? errand.to : undefined))
          }),
    ),
  )
  const quiz = quizState()
  body.replaceChildren(
    div('i_head', '布袋长老'),
    row(
      island.letter.length > 0 ? '正在送信给 ' + island.letter : '今日信件 ' + String(island.sent) + '/' + String(ISLAND.letters),
      '',
      island.letter.length > 0
        ? commandButton('送达', islandCommands.deliverLetter(island.letter))
        : letterFull ? undefined : commandButton('接信', islandCommands.acceptLetter(ISLAND.senders[0] ?? '', firstUnlit)),
    ),
    div('i_head', '岛民与地点'),
    ...npcs,
    ...scenes,
    div('i_head', '今日委托'),
    ...(errands.length === 0 ? [div('i_line', '今天的委托还没有刷新，先点下面的「刷新新闻」开始今天的岛务')] : errands),
    div('i_head', '小艾的心愿'),
    ...(island.loved
      ? [row('已完成', '今天已经送过礼物了')]
      : wantedGift !== null
        ? [row(wantedGift.name, '数量：' + String(wantedGift.num), commandButton('送给小艾', islandCommands.giftNpc('小艾', wantedGift.id)))]
        : [row(want?.name ?? '今日心愿未刷新', want === null ? '先做一件岛上小事，刷新今天的岛务' : '背包里还没有，去商店找找吧')]),
    div('i_head', '今日新闻'),
    ...(news.length === 0 ? [div('i_line', '今天的新闻还没有刷新')] : news),
    div('i_head', '岛上的妖怪'),
    ...monsters,
    div('i_head', '探索地点'),
    ...spots,
    div('i_head', '岛民小游戏'),
    ...plays,
    ...(quiz === null ? [] : [
      div('i_head', '答题 · ' + quiz.quizKind),
      div('i_line', quiz.prompt),
      ...quiz.options.map((option, index) => action(option, () => void answerQuiz(quiz.sessionToken, index))),
    ]),
  )
  acts.replaceChildren(
    commandButton('领成长礼', islandCommands.claimGrowthReward()),
    commandButton('领宝藏碎片', islandCommands.claimTreasure()),
    action('刷新新闻', refreshNews),
    action('去商店', () => { close(); openShop() }),
    action('玩游戏', () => { close(); openGames() }),
  )
}

/** Opens the command-driven island panel; all reads come from the projection and all writes are commands. */
export function openIslandRuntime(): void {
  if (open) return
  open = true
  const phone = phoneUI()
  // Desktop keeps its 580 px framed window. A phone gets a bottom sheet at
  // 1 CSS px = 1 dp: island.css sizes the content for the sheet, so the 580 px
  // canvas and box.ts's whole-window shrink never apply there.
  const body = phone ? div('ui-island qp-island') : div('i_body')
  const acts = phone ? div('qp-island-acts') : div('i_acts')
  const redraw = (): void => renderIsland(body, acts)
  if (phone) {
    const sheet: SheetHandle = openSheet({
      title: '企鹅岛',
      body,
      footer: acts,
      cardClass: 'qp-island-sheet',
      onClose: finishClose,
    })
    closePanel = () => sheet.close()
  } else {
    const title = div('i_title', '企鹅岛')
    closePanel = openBox(div('ui-island', div('island fC', title, body, acts)), { onClose: finishClose })
  }
  offRender = onRender(redraw)
  redraw()
}

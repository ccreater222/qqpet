import type { CommandPayloadMap } from '../sync/protocol'
import {
  ISLAND,
  allGoods,
  findGood,
  parseGoodCode,
  SOLD_IDS,
  goodOf,
  type RuntimeGood,
  type GoodType,
} from './content/index'
import { domainEvent, type DomainEvent } from './events'
import type { HandlerContext, HandlerResult } from './handler-types'
import {
  currentBoundarySeconds,
  earnYb,
  isBusy,
  grantGoods,
  lootGoods,
  readIsland,
  reject,
  requireLivingPet,
  takeGood,
  writeIsland,
  type IslandErrand,
  type IslandState,
} from './runtime-helpers'
import { dayKeyAt, zonedDateTimeParts } from './time'
import { stageOf } from './level'
import type { JsonObject, JsonValue } from './types'

function json<T>(value: T): JsonValue {
  return value as unknown as JsonValue
}

function event(type: string, payload: JsonObject): DomainEvent {
  return domainEvent(type, payload)
}

function requireActor(context: HandlerContext): string {
  const actor = context.ctx.actorDeviceId
  if (actor === null || actor.length === 0) reject('unauthorized', 'an authenticated actor is required')
  return actor
}

function requireIslandReady(context: HandlerContext): IslandState {
  requireLivingPet(context.state)
  requireActor(context)
  if (context.state.save.settings.paused) reject('paused', 'the pet is paused')
  return readIsland(context.state.save, context.ctx.gameTimeMs)
}

function buyable(good: RuntimeGood, level: number): boolean {
  return SOLD_IDS.has(good.id) && typeof good.price === 'number' && good.price > 0 && good.price <= 200 &&
    good.PD !== true && good.outOfPrint !== true && (good.needLevel ?? 0) <= level
}

function dailyWants(state: HandlerContext['state']): RuntimeGood[] {
  const level = state.save.petComputedlInfo.level
  return (['food', 'toy', 'clean'] as const)
    .flatMap(type => allGoods(type))
    .filter(good => buyable(good, level))
}

function tacticOdds(state: HandlerContext['state'], monsterId: string): number {
  const id = Number(monsterId)
  if (Number.isFinite(id) === false || id <= 0) return 0
  let best = 0
  for (const stat of Object.values(ISLAND.tactics)) {
    const value = state.save.petInfo[stat]
    best = Math.max(best, (value + 10) / (value + 10 + 10 * id * id))
  }
  return best
}

function canErrand(kind: string, to: string, state: HandlerContext['state']): boolean {
  if (kind === 'bring') {
    const good = findGood(to)
    return good !== null && buyable(good, state.save.petComputedlInfo.level)
  }
  if (kind === 'fight') return tacticOdds(state, to) >= 0.5
  return true
}

function rollValue(kind: string, from: string, state: HandlerContext['state'], rng: HandlerContext['rng']): string | null {
  if (kind === 'talk') return rng.pickOne(Object.keys(ISLAND.folk).filter(name => name !== from))
  if (kind === 'bring') return rng.pickOne(dailyWants(state))?.id ?? null
  if (kind === 'spot') return rng.pickOne(Object.keys(ISLAND.spots))
  if (kind === 'fight') {
    return rng.pickOne(Object.keys(ISLAND.monsters).filter(id => tacticOdds(state, id) >= 0.5))
  }
  if (kind === 'tour') return String(rng.randIntInclusive(2, 4))
  if (kind === 'chore') {
    const keys = Object.keys(ISLAND.chores)
    const key = rng.pickOne(keys)
    return key === null ? null : key + ':' + String(rng.randIntInclusive(1, ISLAND.chores[key]))
  }
  if (kind === 'gift') return rng.pickOne(Object.keys(ISLAND.gifts))
  if (kind === 'visit') {
    const scene = ISLAND.folk[from]?.scene
    return rng.pickOne(Object.keys(ISLAND.places).filter(id => Number(id) !== scene))
  }
  if (kind === 'chat') return String(rng.randIntInclusive(2, 3))
  if (kind === 'play') return rng.pickOne(Object.keys(ISLAND.plays))
  return null
}

const ROLLED_KINDS = ['talk', 'bring', 'spot', 'fight', 'tour', 'chore', 'gift', 'visit', 'chat', 'play'] as const

function errandNeed(errand: IslandErrand): number {
  return errand.kind === 'chat' || errand.kind === 'tour' ? Number(errand.to) : 1
}

function findErrand(island: IslandState, npcId: string, errandId: string): { index: number; errand: IslandErrand } {
  const index = island.errands.findIndex((errand, candidate) =>
    errand.from === npcId && (
      String(candidate) === errandId ||
      errand.kind === errandId ||
      errand.from + ':' + errand.kind === errandId
    ),
  )
  if (index < 0) reject('not_available', 'island errand was not found')
  return { index, errand: island.errands[index] }
}

function knownNpc(npcId: string): boolean {
  return Object.prototype.hasOwnProperty.call(ISLAND.folk, npcId)
}

function knownSpot(spotId: string): boolean {
  return Object.prototype.hasOwnProperty.call(ISLAND.spots, spotId)
}

function knownMonster(monsterId: string): boolean {
  return Object.prototype.hasOwnProperty.call(ISLAND.monsters, monsterId)
}

function knownPlay(gameKey: string): boolean {
  return Object.prototype.hasOwnProperty.call(ISLAND.plays, gameKey)
}

function sceneOfInput(sceneId: string): number {
  if (Object.prototype.hasOwnProperty.call(ISLAND.places, sceneId)) return Number(sceneId)
  const found = Object.entries(ISLAND.places).find(([, name]) => name === sceneId)
  if (found === undefined) reject('not_available', 'unknown island scene')
  return Number(found[0])
}

function rollErrands(rng: HandlerContext['rng'], state: HandlerContext['state']): IslandErrand[] {
  const written: IslandErrand[] = []
  for (const candidate of rng.shuffle(ISLAND.errands.map(([from, kind, to]) => ({ from, kind, to })))) {
    if (written.length >= 6) break
    if (written.some(errand => errand.from === candidate.from || errand.kind === candidate.kind)) continue
    if (canErrand(candidate.kind, candidate.to, state) === false) continue
    written.push({ ...candidate, got: 0, took: false })
  }

  const made: IslandErrand[] = []
  const available = rng.shuffle(Object.keys(ISLAND.folk).filter(name => written.some(errand => errand.from === name) === false))
  for (const from of available) {
    if (made.length >= 2) break
    const kinds = rng.shuffle(ROLLED_KINDS.filter(kind =>
      written.some(errand => errand.kind === kind) === false &&
      made.some(errand => errand.kind === kind) === false,
    ))
    for (const kind of kinds) {
      const to = rollValue(kind, from, state, rng)
      if (to !== null) {
        made.push({ from, kind, to, got: 0, took: false })
        break
      }
    }
  }

  return [...written, ...made]
}

/** Materializes the canonical 06:00 island day without any AI/presentation prose. */
export function materializeIslandDay(
  state: HandlerContext['state'],
  ctx: HandlerContext['ctx'],
  rng: HandlerContext['rng'],
  island: IslandState,
): IslandState {
  const boundary = currentBoundarySeconds(ctx.gameTimeMs, state.timeZone)
  const currentSeconds = Math.floor(ctx.gameTimeMs / 1000)
  if (island.day === boundary) return island
  if (island.day === currentSeconds && island.errands.length > 0) return island
  island.day = boundary
  island.sent = 0
  island.letter = ''
  island.piece = false
  island.loved = false
  island.fought = []
  island.newsFacts = []
  island.newsDay = 0
  const want = rng.pickOne(dailyWants(state))
  island.want = want?.id ?? ''
  island.errands = rollErrands(rng, state)
  writeIsland(state.save, island)
  return island
}

export function ensureIslandDay(context: HandlerContext, island: IslandState): IslandState {
  return materializeIslandDay(context.state, context.ctx, context.rng, island)
}

function rewardGoods(goods: RuntimeGood[]): JsonValue {
  return goods.map(good => ({ id: good.id, type: good.type, name: good.name, num: good.num }))
}

function finishErrand(context: HandlerContext, island: IslandState, errand: IslandErrand): RuntimeGood[] {
  errand.got = errandNeed(errand)
  errand.took = true
  const goods: RuntimeGood[] = [goodOf('nums', 'yb', context.rng.randIntInclusive(5, 15) * 10)]
  if (context.rng.chance(0.3)) goods.push(...lootGoods(context.rng, 1))
  grantGoods(context.state.save, goods)
  writeIsland(context.state.save, island)
  return goods
}

function currentHour(context: HandlerContext): number {
  return zonedDateTimeParts(context.ctx.gameTimeMs, context.state.timeZone).hour
}

function errandReady(context: HandlerContext, errand: IslandErrand): boolean {
  if (errand.got >= errandNeed(errand)) return true
  if (errand.kind === 'chore') {
    const [counter, count] = errand.to.split(':')
    return counter !== undefined && count !== undefined && (requireTaskCounter(context, counter) ?? 0) >= Number(count)
  }
  if (errand.kind === 'care') {
    if (errand.to === 'hunger') return context.state.save.petInfo.hunger >= context.state.save.petComputedlInfo.hungerMax * 0.8
    if (errand.to === 'clean') return context.state.save.petInfo.clean >= context.state.save.petComputedlInfo.cleanMax * 0.8
    if (errand.to === 'mood') return context.state.save.petInfo.mood >= context.state.save.petComputedlInfo.moodMax * 0.8
  }
  if (errand.kind === 'time') {
    const [from, until] = errand.to.split('-').map(Number)
    const hour = currentHour(context)
    return Number.isFinite(from) && Number.isFinite(until) && hour >= Number(from) && hour < Number(until)
  }
  return false
}

function ownedGoodOfType(context: HandlerContext, type: GoodType): RuntimeGood | null {
  for (const entry of context.state.save.selfGoodDatas[type]) {
    const good = parseGoodCode(entry)
    if (good !== null && good.num > 0) return good
  }
  return null
}

function requireTaskCounter(context: HandlerContext, counter: string): number | null {
  const task = context.state.save.saveJsonData.task
  if (task === undefined) return null
  try {
    const parsed = JSON.parse(task) as { doNums?: Record<string, number> }
    const value = parsed.doNums?.[counter]
    return typeof value === 'number' ? value : null
  } catch {
    return null
  }
}

export function socialCompleteLanVisit(context: HandlerContext, payload: CommandPayloadMap['social.completeLanVisit']): HandlerResult {
  requireLivingPet(context.state)
  requireActor(context)
  if (context.state.save.settings.paused) reject('paused', 'the pet is paused')
  if (context.state.save.petInfo.health < 5) reject('not_available', 'the pet is too ill to visit')
  if (context.state.save.isBury) reject('not_available', 'the pet is buried')
  if (stageOf(context.state.save.petComputedlInfo.level) === 'Egg') reject('not_available', 'the pet is still an egg')
  if (isBusy(context.state.save)) reject('busy', 'the pet is busy')
  const before = context.state.save.petInfo.mood
  const mood = Math.min(10, context.state.save.petComputedlInfo.moodMax - before)
  if (mood > 0) context.state.save.petInfo.mood += mood
  return {
    result: json({ peerId: payload.peerId, direction: payload.direction, mood, visitor: true }),
    events: [event('social.visitCompleted', { peerId: payload.peerId, direction: payload.direction, mood })],
  }
}

export function islandArriveScene(context: HandlerContext, payload: CommandPayloadMap['island.arriveScene']): HandlerResult {
  const scene = sceneOfInput(payload.sceneId)
  const island = ensureIslandDay(context, requireIslandReady(context))
  const tour = island.errands.find(errand => errand.kind === 'tour' && errand.got < errandNeed(errand))
  if (tour !== undefined) tour.got++
  const errand = island.errands.find(candidate =>
    (candidate.kind === 'visit' || candidate.kind === 'seek') && Number(candidate.to) === scene && candidate.got === 0,
  )
  if (errand !== undefined) errand.got = 1
  writeIsland(context.state.save, island)
  return {
    result: json({ sceneId: String(scene), tourProgress: tour?.got ?? 0, errandId: errand === undefined ? null : String(island.errands.indexOf(errand)) }),
    events: [event('island.errandChanged', { sceneId: String(scene), status: errand === undefined ? 'visited' : 'completed' })],
  }
}

export function islandAcceptLetter(context: HandlerContext, payload: CommandPayloadMap['island.acceptLetter']): HandlerResult {
  if (ISLAND.senders.includes(payload.fromNpcId) === false || knownNpc(payload.toNpcId) === false) {
    reject('not_available', 'letters require a canonical sender and known target')
  }
  const island = ensureIslandDay(context, requireIslandReady(context))
  if (island.sent >= ISLAND.letters) reject('already_claimed', 'daily letter allowance is exhausted')
  if (island.letter !== '') reject('busy', 'a letter is already being carried')
  const unlit = Object.keys(ISLAND.folk).filter(name => island.lit.includes(name) === false)
  if (unlit.length > 0 && unlit.includes(payload.toNpcId) === false) {
    reject('not_available', 'the target already received a letter; choose an unlit islander')
  }
  island.letter = payload.toNpcId
  writeIsland(context.state.save, island)
  return {
    result: json({ fromNpcId: payload.fromNpcId, toNpcId: payload.toNpcId, remaining: ISLAND.letters - island.sent }),
    events: [event('island.letterAccepted', { fromNpcId: payload.fromNpcId, toNpcId: payload.toNpcId })],
  }
}

export function islandDeliverLetter(context: HandlerContext, payload: CommandPayloadMap['island.deliverLetter']): HandlerResult {
  if (knownNpc(payload.toNpcId) === false) reject('not_available', 'unknown island npc')
  const island = ensureIslandDay(context, requireIslandReady(context))
  if (island.sent >= ISLAND.letters) reject('already_claimed', 'daily letter allowance is exhausted')
  if (island.letter !== payload.toNpcId) reject('not_available', 'that letter is not being carried')
  const scene = ISLAND.folk[payload.toNpcId].scene
  island.letter = ''
  island.sent++
  if (island.lit.includes(payload.toNpcId) === false) island.lit.push(payload.toNpcId)
  const sceneNpcs = Object.entries(ISLAND.folk).filter(([, folk]) => folk.scene === scene).map(([name]) => name)
  const lamp = island.lamps.includes(scene) === false && sceneNpcs.every(name => island.lit.includes(name))
  if (lamp) island.lamps.push(scene)
  const goods: RuntimeGood[] = [goodOf('nums', 'yb', context.rng.randIntInclusive(5, 20) * 10 + (lamp ? 500 : 0))]
  if (lamp) goods.push(...lootGoods(context.rng, 3))
  grantGoods(context.state.save, goods)
  writeIsland(context.state.save, island)
  return {
    result: json({ toNpcId: payload.toNpcId, sent: island.sent, lamp, goods: rewardGoods(goods) }),
    events: [
      event('island.letterDelivered', { toNpcId: payload.toNpcId, sent: island.sent, lamp }),
      event('island.rewardGranted', { yb: goods[0]?.num ?? 0, goods: rewardGoods(goods) as never }),
    ],
  }
}

export function islandTurnInErrand(context: HandlerContext, payload: CommandPayloadMap['island.turnInErrand']): HandlerResult {
  const island = ensureIslandDay(context, requireIslandReady(context))
  const { errand } = findErrand(island, payload.npcId, payload.errandId)
  if (errand.took) reject('already_claimed', 'the errand was already settled')
  let consumed: RuntimeGood | null = null
  if (errand.kind === 'bring' || errand.kind === 'gift') {
    let item = payload.itemId === undefined ? null : findGood(payload.itemId)
    if (errand.kind === 'gift' && Object.prototype.hasOwnProperty.call(context.state.save.selfGoodDatas, errand.to) === false) {
      reject('not_available', 'unknown gift type')
    }
    if (item === null && errand.kind === 'bring') item = findGood(errand.to)
    if (item === null && errand.kind === 'gift') item = ownedGoodOfType(context, errand.to as GoodType)
    if (item === null) reject('not_available', 'the errand requires an owned item')
    if (errand.kind === 'bring' && item.id !== errand.to) reject('not_available', 'wrong errand item')
    if (errand.kind === 'gift' && item.type !== errand.to) reject('not_available', 'wrong errand gift type')
    if (takeGood(context.state.save, item.type, item.id, 1) === false) reject('insufficient_item', 'the requested item is not owned')
    consumed = { ...item, num: 1 }
  }
  if (errand.kind !== 'bring' && errand.kind !== 'gift' && errandReady(context, errand) === false) {
    reject('not_available', 'the errand is not ready to turn in')
  }
  const goods = finishErrand(context, island, errand)
  const events: DomainEvent[] = [
    event('island.errandChanged', { npcId: payload.npcId, errandId: payload.errandId, status: 'completed' }),
    event('island.rewardGranted', { goods: rewardGoods(goods) as never }),
  ]
  if (consumed !== null) events.push(event('item.consumed', { type: consumed.type, id: consumed.id, count: 1, source: 'island' }))
  return {
    result: json({ errandId: payload.errandId, status: 'completed', goods: rewardGoods(goods), consumed }),
    events,
  }
}

export function islandFightMonster(context: HandlerContext, payload: CommandPayloadMap['island.fightMonster']): HandlerResult {
  if (knownMonster(payload.monsterId) === false) reject('not_available', 'unknown island monster')
  const stat = ISLAND.tactics[payload.tactic]
  if (stat === undefined) reject('invalid_payload', 'unknown monster tactic')
  const island = ensureIslandDay(context, requireIslandReady(context))
  if (island.fought.includes(payload.monsterId)) reject('already_claimed', 'this monster was already fought today')
  const value = context.state.save.petInfo[stat]
  const id = Number(payload.monsterId)
  const chance = (value + 10) / (value + 10 + 10 * id * id)
  const won = context.rng.chance(chance)
  island.fought.push(payload.monsterId)
  if (won) island.wins++
  const errand = island.errands.find(candidate => candidate.kind === 'fight' && candidate.to === payload.monsterId && candidate.got === 0)
  if (won && errand !== undefined) errand.got = 1
  const goods: RuntimeGood[] = []
  if (won) {
    goods.push(goodOf('nums', 'yb', 10 + 5 * id))
    if (context.rng.chance(0.1)) goods.push(...lootGoods(context.rng, 1))
    grantGoods(context.state.save, goods)
  }
  writeIsland(context.state.save, island)
  const events: DomainEvent[] = [event('island.combatSettled', { monsterId: payload.monsterId, tactic: payload.tactic, won, goods: rewardGoods(goods) as never })]
  if (goods.length > 0) events.push(event('island.rewardGranted', { kind: 'combat', monsterId: payload.monsterId, goods: rewardGoods(goods) as never }))
  return {
    result: json({ monsterId: payload.monsterId, monsterName: ISLAND.monsters[payload.monsterId].name, tactic: payload.tactic, won, chance, goods: rewardGoods(goods), wins: island.wins }),
    events,
  }
}

export function islandClaimGrowthReward(context: HandlerContext): HandlerResult {
  const island = ensureIslandDay(context, requireIslandReady(context))
  const tier = Math.floor(context.state.save.petComputedlInfo.level / ISLAND.tier)
  if (tier <= island.tier) reject('already_claimed', 'growth reward is not available yet')
  const count = tier - island.tier
  island.tier = tier
  const goods: RuntimeGood[] = [goodOf('nums', 'yb', 200 * count), ...lootGoods(context.rng, count)]
  grantGoods(context.state.save, goods)
  writeIsland(context.state.save, island)
  return {
    result: json({ tier, goods: rewardGoods(goods) }),
    events: [event('island.rewardGranted', { kind: 'growth', tier, goods: rewardGoods(goods) as never })],
  }
}

export function islandClaimTreasure(context: HandlerContext): HandlerResult {
  const island = ensureIslandDay(context, requireIslandReady(context))
  if (island.piece) reject('already_claimed', 'a treasure piece was already claimed today')
  island.piece = true
  island.pieces++
  const full = island.pieces >= ISLAND.pieces
  if (full) island.pieces = 0
  const goods: RuntimeGood[] = full ? [goodOf('nums', 'yb', 500), ...lootGoods(context.rng, 4)] : []
  if (full) grantGoods(context.state.save, goods)
  writeIsland(context.state.save, island)
  return {
    result: json({ full, pieces: island.pieces, goods: rewardGoods(goods) }),
    events: [event('island.rewardGranted', { kind: 'treasure', full, pieces: island.pieces, goods: rewardGoods(goods) as never })],
  }
}

export function islandGiftNpc(context: HandlerContext, payload: CommandPayloadMap['island.giftNpc']): HandlerResult {
  const island = ensureIslandDay(context, requireIslandReady(context))
  if (payload.npcId !== '小艾') reject('not_available', 'only 小艾 has a daily love request')
  if (island.loved) reject('already_claimed', 'the daily love request was already completed')
  if (island.want.length === 0) reject('not_available', 'no daily want is available')
  if (payload.itemId !== island.want) reject('not_available', 'the gift does not match 小艾\'s daily want')
  const item = findGood(island.want)
  if (item === null) reject('not_available', 'the daily want item is unknown')
  if (takeGood(context.state.save, item.type, item.id, 1) === false) reject('insufficient_item', 'the daily want item is not owned')
  island.loved = true
  const goods: RuntimeGood[] = [goodOf('nums', 'yb', context.rng.randIntInclusive(10, 30) * 10), ...lootGoods(context.rng, 1)]
  grantGoods(context.state.save, goods)
  writeIsland(context.state.save, island)
  return {
    result: json({ npcId: payload.npcId, itemId: payload.itemId, loved: true, goods: rewardGoods(goods) }),
    events: [
      event('island.rewardGranted', { kind: 'love', npcId: payload.npcId, goods: rewardGoods(goods) as never }),
      event('item.consumed', { type: item.type, id: item.id, count: 1, source: 'island' }),
    ],
  }
}

export function islandTalkNpc(context: HandlerContext, payload: CommandPayloadMap['island.talkNpc']): HandlerResult {
  if (knownNpc(payload.npcId) === false) reject('not_available', 'unknown island npc')
  const island = ensureIslandDay(context, requireIslandReady(context))
  const errand = island.errands.find(candidate => candidate.kind === 'talk' && candidate.to === payload.npcId && candidate.got === 0)
  if (errand !== undefined) errand.got = 1
  writeIsland(context.state.save, island)
  return {
    result: json({ npcId: payload.npcId, errandProgress: errand === undefined ? null : 1 }),
    events: [event('island.errandChanged', { npcId: payload.npcId, status: errand === undefined ? 'talked' : 'progressed' })],
  }
}

export function islandVisitSpot(context: HandlerContext, payload: CommandPayloadMap['island.visitSpot']): HandlerResult {
  if (knownSpot(payload.spotId) === false) reject('not_available', 'unknown island spot')
  const island = ensureIslandDay(context, requireIslandReady(context))
  const errand = island.errands.find(candidate => candidate.kind === 'spot' && candidate.to === payload.spotId && candidate.got === 0)
  if (errand !== undefined) errand.got = 1
  writeIsland(context.state.save, island)
  return {
    result: json({ spotId: payload.spotId, errandProgress: errand === undefined ? null : 1 }),
    events: [event('island.errandChanged', { spotId: payload.spotId, status: errand === undefined ? 'visited' : 'progressed' })],
  }
}

export function islandChat(context: HandlerContext, payload: CommandPayloadMap['island.chat']): HandlerResult {
  const island = ensureIslandDay(context, requireIslandReady(context))
  const errand = island.errands.find(candidate => candidate.kind === 'chat' && candidate.got < errandNeed(candidate))
  if (errand !== undefined) errand.got++
  writeIsland(context.state.save, island)
  return {
    result: json({ npcId: payload.npcId, progress: errand?.got ?? null, target: errand?.to ?? null }),
    events: [event('island.errandChanged', { npcId: payload.npcId, status: 'chat_progress' })],
  }
}

export function islandPlayGame(context: HandlerContext, payload: CommandPayloadMap['island.playGame']): HandlerResult {
  if (knownPlay(payload.gameKey) === false) reject('not_available', 'unknown island game')
  const island = ensureIslandDay(context, requireIslandReady(context))
  const errand = island.errands.find(candidate => candidate.kind === 'play' && candidate.to === payload.gameKey && candidate.got === 0)
  if (errand !== undefined) errand.got = 1
  writeIsland(context.state.save, island)
  return {
    result: json({ gameKey: payload.gameKey, errandProgress: errand === undefined ? null : 1 }),
    events: [event('island.errandChanged', { gameKey: payload.gameKey, status: errand === undefined ? 'played' : 'progressed' })],
  }
}

export function islandRefreshNews(context: HandlerContext, payload: CommandPayloadMap['island.refreshNews']): HandlerResult {
  const island = ensureIslandDay(context, requireIslandReady(context))
  const expectedDayKey = dayKeyAt(context.ctx.gameTimeMs, context.state.timeZone)
  if (payload.dayKey !== expectedDayKey) reject('not_available', 'news refresh is for a stale day')
  if (island.newsFacts.length === 4 && island.newsDay === island.day) {
    const cached = island.newsFacts.map(([heading, fact]) => ({ heading, fact }))
    return {
      result: json({ dayKey: payload.dayKey, facts: cached, cached: true }),
      events: [event('island.newsRefreshed', { dayKey: payload.dayKey, count: cached.length, cached: true })],
    }
  }
  const selected = context.rng.shuffle(ISLAND.facts).slice(0, 4)
  island.newsFacts = selected.map(([heading, fact]) => [heading, fact])
  island.newsDay = island.day
  writeIsland(context.state.save, island)
  const facts = island.newsFacts.map(([heading, fact]) => ({ heading, fact }))
  return {
    result: json({ dayKey: payload.dayKey, facts, cached: false }),
    events: [event('island.newsRefreshed', { dayKey: payload.dayKey, count: facts.length, cached: false })],
  }
}

export function islandStateForTest(context: HandlerContext): IslandState {
  return ensureIslandDay(context, requireIslandReady(context))
}

export function islandGoodsForTest(good: RuntimeGood): JsonValue {
  return rewardGoods([good])
}

export function islandTypeIsGift(type: string): type is GoodType {
  return Object.prototype.hasOwnProperty.call(ISLAND.gifts, type)
}

export function islandYbGood(amount: number): RuntimeGood {
  return goodOf('nums', 'yb', amount)
}

export function islandEarnYb(context: HandlerContext, amount: number): number {
  return earnYb(context.state.save, amount)
}

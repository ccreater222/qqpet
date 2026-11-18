import type { StudyInfo } from '../save'
import type { CommandError } from '../sync/protocol'
import { stableStringify } from './serialization'
import {
  chance as rngChance,
  cloneRngState,
  loot as rngLoot,
  nextRngWord,
  pickOne as rngPickOne,
  randIntInclusive as rngRandIntInclusive,
  randomIndex as rngRandomIndex,
  randomUnit as rngRandomUnit,
  shuffle as rngShuffle,
} from './rng'
import type {
  EngineState,
  GameSessionState,
  JsonObject,
  RngState,
  ScheduledJob,
  ScheduledJobType,
} from './types'
import type { SharedSaveData } from '../sync/data-boundary'
import type { SharedSaveJsonKey } from '../sync/data-boundary'
import {
  allGoods,
  findGood,
  goodOf,
  parseGoodCode,
  type GoodType,
  type RuntimeGood,
  type TimedType,
  LOOT_POOLS,
} from './content/index'
import { dailyBoundaryMs, dayKeyAt, zonedDateTimeParts } from './time'
import { levelAndCapsOf } from './level'
import { applyGoodStats, clampHealth, growthPerMinute, sumTimedGoodGroupBonuses } from './stats'

export interface RuntimeRng {
  readonly state: RngState
  randomUnit(): number
  randIntInclusive(min: number, max: number): number
  randomIndex(count: number): number | null
  pickOne<T>(items: readonly T[]): T | null
  shuffle<T>(items: readonly T[]): T[]
  chance(probability: number): boolean
  loot<T>(pools: readonly (readonly T[])[]): T
  tokenHex(): string
}

export function createRuntimeRng(initial: RngState): RuntimeRng {
  let state = cloneRngState(initial)
  return {
    get state(): RngState {
      return state
    },
    randomUnit(): number {
      const step = rngRandomUnit(state)
      state = step.state
      return step.value
    },
    randIntInclusive(min: number, max: number): number {
      const step = rngRandIntInclusive(state, min, max)
      state = step.state
      return step.value
    },
    randomIndex(count: number): number | null {
      const step = rngRandomIndex(state, count)
      state = step.state
      return step.value
    },
    pickOne<T>(items: readonly T[]): T | null {
      const step = rngPickOne(state, items)
      state = step.state
      return step.value
    },
    shuffle<T>(items: readonly T[]): T[] {
      const step = rngShuffle(state, items)
      state = step.state
      return step.value
    },
    chance(probability: number): boolean {
      const step = rngChance(state, probability)
      state = step.state
      return step.value
    },
    loot<T>(pools: readonly (readonly T[])[]): T {
      const step = rngLoot(state, pools)
      state = step.state
      return step.value
    },
    tokenHex(): string {
      const words: string[] = []
      for (let index = 0; index < 4; index++) {
        const step = nextRngWord(state)
        state = step.state
        words.push(step.value.toString(16).padStart(8, '0'))
      }
      return words.join('')
    },
  }
}

export function cloneEngine(state: EngineState): EngineState {
  return JSON.parse(stableStringify(state)) as EngineState
}

export class RuntimeFailure extends Error {
  readonly error: CommandError

  constructor(error: CommandError) {
    super(error.message)
    this.name = 'RuntimeFailure'
    this.error = error
  }
}

export function reject(code: CommandError['code'], message: string, retryable = false): never {
  throw new RuntimeFailure({ code, message, refreshProjection: false, ...(retryable ? { retryable: true } : {}) })
}

export function runtimeError(code: CommandError['code'], message: string, retryable = false): RuntimeFailure {
  return new RuntimeFailure({ code, message, refreshProjection: false, ...(retryable ? { retryable: true } : {}) })
}

export function assertOwnerRole(role: string | undefined): void {
  if (role !== 'owner') reject('unauthorized', 'owner authority is required')
}

export function hasPet(state: EngineState): boolean {
  return state.save.havePet && state.save.petInfo.health > 0
}

export function requirePet(state: EngineState): void {
  if (state.save.havePet === false) reject('no_pet', 'there is no pet to act on')
}

export function requireLivingPet(state: EngineState): void {
  requirePet(state)
  if (state.save.petInfo.health <= 0) reject('pet_dead', 'the pet is dead')
}

export function requireNotPaused(state: EngineState): void {
  if (state.save.settings.paused) reject('paused', 'the pet is paused')
}

export function isBusy(save: SharedSaveData): boolean {
  return save.activeOption.work !== null || save.activeOption.study !== null || save.activeOption.trip !== null
}

export type TaskCounter = 'Amusing' | 'Travel1' | 'Eat' | 'Clean' | 'Toy' | 'Work' | 'Study' | 'GameRound' | 'Game' | 'Travel2'
export type TaskTab = 'daily' | 'ddw' | 'growth' | 'travel'
export interface TaskDefinition {
  label: string
  msg: string
  obj: TaskCounter
  num: number
  keep?: boolean
  reroll?: number
  good?: string[]
}
export interface TaskEntry { take: boolean; good: RuntimeGood[] }
export interface TaskProgress {
  doNums: Partial<Record<TaskCounter, number>>
  taskList: Record<TaskTab, TaskEntry[]>
  daily: TaskDefinition[]
  dailyDay: number
}

export interface SignInState {
  collectionList: Record<string, Record<string, number[]>>
  getGrowth: [number[], number[] | null] | null
  onlineGiftNum: number
  isOnlineLastTime: number
  getBirthDayGift: boolean
}

export interface LiveMail {
  d: number
  l: string
  glb: RuntimeGood[]
  r?: boolean
  m?: string
  k?: string
  p?: string
}
export type MailState = LiveMail | { d: number; e: true; k?: string }
export type MailMap = Record<string, MailState>

export interface IslandErrand { from: string; kind: string; to: string; got: number; took: boolean }
export interface IslandState {
  day: number
  sent: number
  letter: string
  lit: string[]
  lamps: number[]
  tier: number
  pieces: number
  piece: boolean
  want: string
  loved: boolean
  errands: IslandErrand[]
  fought: string[]
  wins: number
  newsFacts: [string, string][]
  newsDay: number
}

export interface FishState {
  id: number
  fryid: number
  name: string
  stage: number
  time: number
  interval: number
  costyb: number
  YB: number
  quantity: number
  basequantity: number
  avatar: number
  AIXIN: number
  growth: number
  strong: number
  iq: number
  charm: number
  born: number
  siLiao: number
}
export interface PondState { PD: { allvipcnt: number; canusecnt: number }; fishs: FishState[] }

export function readSharedBlob<T>(save: SharedSaveData, key: SharedSaveJsonKey, fallback: T): T {
  const raw = save.saveJsonData[key]
  if (raw === undefined) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeSharedBlob(save: SharedSaveData, key: SharedSaveJsonKey, value: unknown): void {
  save.saveJsonData[key] = stableStringify(value)
}

export function defaultTaskProgress(): TaskProgress {
  return { doNums: {}, taskList: { daily: [], ddw: [], growth: [], travel: [] }, daily: [], dailyDay: 0 }
}

export function readTaskProgress(save: SharedSaveData): TaskProgress {
  const fallback = defaultTaskProgress()
  const parsed = readSharedBlob<Partial<TaskProgress>>(save, 'task', {})
  return {
    doNums: parsed.doNums ?? {},
    taskList: {
      daily: parsed.taskList?.daily ?? fallback.taskList.daily,
      ddw: parsed.taskList?.ddw ?? fallback.taskList.ddw,
      growth: parsed.taskList?.growth ?? fallback.taskList.growth,
      travel: parsed.taskList?.travel ?? fallback.taskList.travel,
    },
    daily: parsed.daily ?? [],
    dailyDay: parsed.dailyDay ?? 0,
  }
}

export function writeTaskProgress(save: SharedSaveData, task: TaskProgress): void {
  writeSharedBlob(save, 'task', task)
}

export function addTaskCount(save: SharedSaveData, counter: Exclude<TaskCounter, 'Travel2'>, amount = 1): TaskProgress {
  const task = readTaskProgress(save)
  task.doNums[counter] = (task.doNums[counter] ?? 0) + amount
  writeTaskProgress(save, task)
  return task
}

export function taskCount(save: SharedSaveData, counter: TaskCounter): number {
  if (counter === 'Travel2') return save.gameSaveDatas.travel_china.length
  return readTaskProgress(save).doNums[counter] ?? 0
}

export function defaultSignIn(): SignInState {
  return { collectionList: {}, getGrowth: null, onlineGiftNum: 0, isOnlineLastTime: 20, getBirthDayGift: true }
}

export function readSignIn(save: SharedSaveData): SignInState {
  const parsed = readSharedBlob<Partial<SignInState>>(save, 'signin', {})
  return {
    collectionList: parsed.collectionList ?? {},
    getGrowth: parsed.getGrowth ?? null,
    onlineGiftNum: parsed.onlineGiftNum ?? 0,
    isOnlineLastTime: parsed.isOnlineLastTime ?? 20,
    getBirthDayGift: parsed.getBirthDayGift ?? true,
  }
}

export function writeSignIn(save: SharedSaveData, signin: SignInState): void {
  writeSharedBlob(save, 'signin', signin)
}

export function readMails(save: SharedSaveData): MailMap {
  return readSharedBlob<MailMap>(save, 'email', {})
}

export function writeMails(save: SharedSaveData, mails: MailMap): void {
  writeSharedBlob(save, 'email', mails)
}

export function defaultIsland(gameTimeMs: number): IslandState {
  return {
    day: Math.floor(gameTimeMs / 1000), sent: 0, letter: '', lit: [], lamps: [], tier: 0,
    pieces: 0, piece: false, want: '', loved: false, errands: [], fought: [], wins: 0,
    newsFacts: [], newsDay: 0,
  }
}

export function readIsland(save: SharedSaveData, gameTimeMs: number): IslandState {
  const parsed = readSharedBlob<Partial<IslandState>>(save, 'island', {})
  if (parsed.newsFacts !== undefined) {
    if (Array.isArray(parsed.newsFacts) === false || parsed.newsFacts.some(fact =>
      Array.isArray(fact) === false || fact.length !== 2 ||
      typeof fact[0] !== 'string' || typeof fact[1] !== 'string',
    )) reject('invalid_payload', 'malformed island newsFacts')
  }
  if (parsed.newsDay !== undefined &&
      (typeof parsed.newsDay !== 'number' || Number.isSafeInteger(parsed.newsDay) === false || parsed.newsDay < 0)) {
    reject('invalid_payload', 'malformed island newsDay')
  }
  return {
    day: parsed.day ?? Math.floor(gameTimeMs / 1000),
    sent: parsed.sent ?? 0,
    letter: parsed.letter ?? '',
    lit: parsed.lit ?? [],
    lamps: parsed.lamps ?? [],
    tier: parsed.tier ?? 0,
    pieces: parsed.pieces ?? 0,
    piece: parsed.piece ?? false,
    want: parsed.want ?? '',
    loved: parsed.loved ?? false,
    errands: parsed.errands ?? [],
    fought: parsed.fought ?? [],
    wins: parsed.wins ?? 0,
    newsFacts: parsed.newsFacts ?? [],
    newsDay: parsed.newsDay ?? 0,
  }
}

export function writeIsland(save: SharedSaveData, island: IslandState): void {
  writeSharedBlob(save, 'island', island)
}

export function readPond(save: SharedSaveData): PondState {
  const parsed = readSharedBlob<Partial<PondState>>(save, 'fishs', {})
  return { PD: parsed.PD ?? { allvipcnt: 0, canusecnt: 0 }, fishs: parsed.fishs ?? [] }
}

export function writePond(save: SharedSaveData, pond: PondState): void {
  writeSharedBlob(save, 'fishs', pond)
}

export function inventoryIndex(save: SharedSaveData, type: GoodType, id: string): number {
  return save.selfGoodDatas[type].findIndex((entry: string) => entry.startsWith('_' + id + '*'))
}

export function inventoryCount(save: SharedSaveData, type: GoodType, id: string): number {
  const index = inventoryIndex(save, type, id)
  if (index < 0) return 0
  return Number(save.selfGoodDatas[type][index].split('*')[1] ?? 0) || 0
}

export function addGood(save: SharedSaveData, good: RuntimeGood, count = good.num): void {
  if (Number.isSafeInteger(count) === false || count <= 0) return
  if (save.illustrated.includes(good.id) === false) save.illustrated.push(good.id)
  const list = save.selfGoodDatas[good.type]
  const index = inventoryIndex(save, good.type, good.id)
  const next = (index >= 0 ? Number(list[index].split('*')[1] ?? 0) : 0) + count
  const code = '_' + good.id + '*' + String(next)
  if (index >= 0) list[index] = code
  else list.push(code)
}

export function takeGood(save: SharedSaveData, type: GoodType, id: string, count = 1): boolean {
  const current = inventoryCount(save, type, id)
  if (current < count) return false
  const index = inventoryIndex(save, type, id)
  const list = save.selfGoodDatas[type]
  const left = current - count
  if (left > 0) list[index] = '_' + id + '*' + String(left)
  else list.splice(index, 1)
  return true
}

export function grantGoods(save: SharedSaveData, goods: readonly RuntimeGood[]): void {
  for (const good of goods) addGood(save, good, good.num)
}

export function parseRewardCodes(codes: readonly string[]): RuntimeGood[] {
  const result: RuntimeGood[] = []
  for (const code of codes) {
    const good = parseGoodCode(code)
    if (good !== null) result.push(good)
  }
  return result
}

export function normalizeGoods(goods: readonly RuntimeGood[]): RuntimeGood[] {
  return goods.map(good => findGood(good.id) === null ? good : { ...good, type: good.type })
}

export function applyGood(save: SharedSaveData, good: RuntimeGood, extraMood = 0): void {
  const info = save.petInfo
  const caps = save.petComputedlInfo
  const next = applyGoodStats(
    { hunger: info.hunger, clean: info.clean, mood: info.mood, intel: info.intel, charm: info.charm, strong: info.strong },
    { hungerMax: caps.hungerMax, cleanMax: caps.cleanMax, moodMax: caps.moodMax },
    { hunger: good.hunger, clean: good.clean, mood: good.mood, intel: good.intel, charm: good.charm, strong: good.strong },
    extraMood,
  )
  info.hunger = next.hunger
  info.clean = next.clean
  info.mood = next.mood
  info.intel = next.intel
  info.charm = next.charm
  info.strong = next.strong
}

export function startTimedGood(save: SharedSaveData, good: RuntimeGood, minutes: number): void {
  if (good.type !== 'food' && good.type !== 'clean' && good.type !== 'toy' && good.type !== 'background') return
  save.selfGoodUseOption[good.type as TimedType] = { id: good.id, left: minutes }
}

export function sumTimedGroupBonus(save: SharedSaveData): number {
  return sumTimedGoodGroupBonuses(save.selfGoodUseOption, (type, id) => {
    try {
      return goodOf(type as GoodType, id).group ?? 0
    } catch {
      return 0
    }
  })
}

export function currentGrowthPerMinute(save: SharedSaveData): number {
  return growthPerMinute({
    mood: save.petInfo.mood,
    pinkDiamond: save.petInfo.pinkDiamond,
    sweetHeartOverTime: save.petInfo.sweetHeartOverTime > 0,
    timedGoodGroupBonus: sumTimedGroupBonus(save),
  })
}

export function recomputePetComputed(save: SharedSaveData): { previousLevel: number; level: number } {
  const previousLevel = save.petComputedlInfo.level
  const computed = levelAndCapsOf(save.petInfo.growth)
  save.petComputedlInfo = {
    level: computed.level,
    upGrowth: computed.upGrowth,
    nextGrowth: computed.nextGrowth,
    hungerMax: computed.hungerMax,
    cleanMax: computed.cleanMax,
    healthMax: 5,
    moodMax: 1000,
  }
  save.petInfo.health = clampHealth(save.petInfo.health)
  return { previousLevel, level: computed.level }
}

export function scaleYbForDifficulty(save: SharedSaveData, amount: number): number {
  return amount > 0 && save.settings.difficulty === 'standard' ? Math.max(1, Math.round(amount * 0.4)) : amount
}

export function earnYb(save: SharedSaveData, amount: number): number {
  const got = scaleYbForDifficulty(save, amount)
  save.petInfo.yb += got
  return got
}

export function payYb(save: SharedSaveData, amount: number): void {
  if (Number.isSafeInteger(amount) === false || amount < 0) reject('invalid_payload', 'invalid amount')
  if (save.petInfo.yb < amount) reject('insufficient_funds', 'not enough yuanbao')
  save.petInfo.yb -= amount
}

export function scheduleJob(
  state: EngineState,
  type: ScheduledJobType,
  dueAtGameMs: number,
  payload: JsonObject,
): ScheduledJob {
  const job: ScheduledJob = { id: state.nextScheduledJobId, type, dueAtGameMs, payload, status: 'pending' }
  state.nextScheduledJobId += 1
  state.scheduledJobs.push(job)
  return job
}

export function cancelPendingJobs(state: EngineState, predicate: (job: ScheduledJob) => boolean): void {
  for (const job of state.scheduledJobs) {
    if (job.status === 'pending' && predicate(job)) job.status = 'cancelled'
  }
}

export function findPendingJob(state: EngineState, type: ScheduledJobType, key: string, value: string): ScheduledJob | null {
  return state.scheduledJobs.find(job =>
    job.status === 'pending' && job.type === type && job.payload[key] === value,
  ) ?? null
}

export function setActive(save: SharedSaveData, kind: 'work' | 'study' | 'trip', value: string | null): void {
  save.activeOption[kind] = value
  writeSharedBlob(save, 'activity', value === null ? '0' : '0')
}

export function clearAllActivities(save: SharedSaveData): void {
  save.activeOption.work = null
  save.activeOption.study = null
  save.activeOption.trip = null
  writeSharedBlob(save, 'activity', 0)
}

export function findSession(state: EngineState, token: string): GameSessionState | undefined {
  return state.gameSessions.find(session => session.sessionToken === token)
}

export function cancelSessionJob(state: EngineState, token: string): void {
  cancelPendingJobs(state, job => job.type === 'game-session' && job.payload.sessionToken === token)
}

export function lootGoods(rng: RuntimeRng, count: number, pool: number | null = null): RuntimeGood[] {
  const goods: RuntimeGood[] = []
  for (let index = 0; index < count; index++) {
    let selectedPool = pool
    if (selectedPool === null) {
      const unit = rng.randomUnit()
      selectedPool = unit < 0.02 ? 0 : unit < 0.27 ? 1 : 2
    }
    const list = LOOT_POOLS[selectedPool]
    if (list === undefined || list.length === 0) continue
    const index = rng.randomIndex(list.length)
    if (index === null) continue
    const code = list[index]
    const good = parseGoodCode(code)
    if (good !== null) goods.push(good)
  }
  return goods
}

export function currentBoundarySeconds(gameTimeMs: number, timeZone: string): number {
  const key = dayKeyAt(gameTimeMs, timeZone)
  return Math.floor(dailyBoundaryMs(key, timeZone) / 1000)
}

export function localDate(gameTimeMs: number, timeZone: string): { year: number; month: number; day: number } {
  const parts = zonedDateTimeParts(gameTimeMs, timeZone)
  return { year: parts.year, month: parts.month, day: parts.day }
}

export function mailSlot(mails: MailMap, gameTimeMs: number): number {
  let slot = Math.floor(gameTimeMs / 1000)
  while (mails[String(slot)] !== undefined) slot++
  return slot
}

function someUniqueGoods(type: 'food' | 'toy', count: number, rng: RuntimeRng): RuntimeGood[] {
  const pool = allGoods(type)
  const picks: RuntimeGood[] = []
  for (let index = 0; index < count && pool.length > 0; index++) {
    const selected = rng.randIntInclusive(0, pool.length - 1)
    const good = pool.splice(selected, 1)[0]
    picks.push({ ...good, num: rng.randIntInclusive(1, 3) })
  }
  return picks
}

export function mailGoods(save: SharedSaveData, yb: number, rng: RuntimeRng): RuntimeGood[] {
  const picks = [...someUniqueGoods('food', 3, rng), ...someUniqueGoods('toy', 2, rng)]
  picks.push({ ...goodOf('nums', 'yb'), num: scaleYbForDifficulty(save, yb) })
  return picks
}

export function finiteInteger(value: unknown, name: string, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || Number.isSafeInteger(value) === false || value < min || value > max) {
    reject('invalid_payload', name + ' must be an integer between ' + min + ' and ' + max)
  }
  return value
}

export function assertGoodType(type: unknown): asserts type is GoodType {
  if (typeof type !== 'string' || Object.prototype.hasOwnProperty.call({ food: true, clean: true, medicine: true, background: true, toy: true, nums: true, service: true, work: true, study: true, trip: true }, type) === false) {
    reject('invalid_payload', 'unknown inventory type')
  }
}

export function studySubjectOf(save: SharedSaveData, courseId: string): keyof StudyInfo | null {
  const good = goodOf('study', courseId)
  const subject = (good as RuntimeGood & { value?: string }).value
  if (subject === undefined || Object.prototype.hasOwnProperty.call(save.studyInfo, subject) === false) return null
  return subject as keyof StudyInfo
}

export function settlementEvents(events: import('./events').DomainEvent[]): import('./events').DomainEvent[] {
  return events
}

export function engineStateSignature(state: EngineState): string {
  return stableStringify(state)
}

/**
 * DOM-free canonical content tables used by the headless runtime. These are
 * copies of the renderer's existing data JSON during extraction; C3 does not
 * modify or wire renderer production files.
 */
import type { SelfGoodDatas, SelfGoodUseOption, StudyInfo } from '../../save'
import GOODS from './goods.json' with { type: 'json' }
import POOLS from './pool.json' with { type: 'json' }
import TRAVEL from './travel.json' with { type: 'json' }
import EXAM from './exam.json' with { type: 'json' }
import TASK_TABLES from './tasks.json' with { type: 'json' }
import ALBUM from './album.json' with { type: 'json' }
import FRIES_TABLE from './fries.json' with { type: 'json' }
import FARM from './farm.json' with { type: 'json' }
import ISLAND_TABLE from './island.json' with { type: 'json' }
import SHOP_TABLE from './shop.json' with { type: 'json' }

export type GoodType = keyof SelfGoodDatas
export type TimedType = keyof SelfGoodUseOption

export interface RuntimeGood {
  id: string
  name: string
  type: GoodType
  url: string
  desc?: string
  price?: number
  needLevel?: number
  PD?: boolean
  outOfPrint?: boolean
  hunger?: number
  clean?: number
  mood?: number
  intel?: number
  charm?: number
  strong?: number
  group?: number
  useTimeing?: number
  value?: number | string
  useId?: string
  useTime?: number
  yb?: number
  education?: Partial<StudyInfo>
  useArtt?: Partial<Record<'charm' | 'intel' | 'strong', number>>
  object?: string
  tolkName?: string
  classNum?: number
  classNumUp?: number
  school?: number
  num: number
}

type RawGood = Omit<RuntimeGood, 'num'>
const GOODS_TABLE = GOODS as unknown as Record<GoodType, Record<string, RawGood>>

const ID_INDEX = new Map<string, { type: GoodType; raw: RawGood }>()
for (const type of Object.keys(GOODS_TABLE) as GoodType[]) {
  for (const [key, raw] of Object.entries(GOODS_TABLE[type])) {
    ID_INDEX.set(key.startsWith('_') ? key.slice(1) : key, { type, raw })
  }
}

export function findGood(id: string): RuntimeGood | null {
  const found = ID_INDEX.get(id)
  return found === undefined ? null : { ...found.raw, num: 1 }
}

export function goodOf(type: GoodType, id: string, num = 1): RuntimeGood {
  const raw = GOODS_TABLE[type]?.[`_${id}`]
  if (raw === undefined) throw new Error('unknown good: ' + type + '/' + id)
  return { ...raw, num }
}

export function allGoods(type: GoodType): RuntimeGood[] {
  return Object.values(GOODS_TABLE[type] ?? {}).map(raw => ({ ...raw, num: 1 }))
}

export function goodMatchesType(type: string, id: string): boolean {
  if (Object.prototype.hasOwnProperty.call(GOODS_TABLE, type) === false) return false
  return GOODS_TABLE[type as GoodType][`_${id}`] !== undefined
}

export function parseGoodCode(code: string, fallbackCount = 1): RuntimeGood | null {
  if (code.startsWith('_') === false) return null
  const [id, count] = code.slice(1).split('*')
  const good = findGood(id)
  if (good === null) return null
  const num = count === undefined ? fallbackCount : Number(count)
  if (Number.isSafeInteger(num) === false || num < 0) return null
  return { ...good, num }
}

export function formatGoodCode(good: Pick<RuntimeGood, 'id'>, num = 1): string {
  return '_' + good.id + '*' + String(num)
}

export interface TravelProvince {
  name: string
  extraordinaryEncounter: { tolk: string; submitText: string }[]
}

export interface ExamBankEntry {
  title: string
  options: string[]
  answer: string
}

export const WORK_GOODS: RuntimeGood[] = allGoods('work')
export const STUDY_GOODS: RuntimeGood[] = allGoods('study')
export const TRAVEL_PROVINCES = TRAVEL as unknown as TravelProvince[]
export const EXAM_BANK = EXAM as unknown as Record<string, ExamBankEntry[]>
export const LOOT_POOLS = POOLS as unknown as string[][]
export interface PhotoDefinition { id: string; p: string; b: boolean }
export const PHOTOS = ALBUM as unknown as PhotoDefinition[]

export const BIRTHDAY_FOOD_IDS = [
  '100010496', '100010497', '10011014', '100010033', '100010100', '100010106', '100010109',
  '100010110', '100010123', '100010197', '100010241', '100010298', '100010305', '100010337',
  '100010338', '100010461', '100010489', '100010491', '100010494',
] as const

export const SUBJECTS: (keyof StudyInfo)[] = [
  'chinese', 'mathematics', 'politics', 'music', 'art', 'manner', 'pe', 'labouring', 'wushu',
]

export const SCHOOL_RANGES = [
  { max: 9, key: 'xx', name: '' },
  { max: 30, key: 'zx', name: '小学' },
  { max: 71, key: 'dx', name: '中学' },
  { max: 167, key: 'yjs', name: '大学' },
  { max: Infinity, key: 'xwzj', name: '研究生' },
] as const

export function schoolOf(studyValue: number): (typeof SCHOOL_RANGES)[number] {
  return SCHOOL_RANGES.find(range => studyValue <= range.max) ?? SCHOOL_RANGES[SCHOOL_RANGES.length - 1]
}

export type TaskNeedKind = 'hungerLow' | 'cleanLow' | 'moodLow' | 'ybLow' | 'studyDay' | 'dayOff'
export type DailyTaskObject = 'Eat' | 'Clean' | 'Toy' | 'Amusing' | 'Work' | 'Study' | 'GameRound' | 'Game' | 'Travel1'

export interface DailyTaskTemplate {
  obj: DailyTaskObject
  label: string
  num: [number, number]
  msg: [string, string]
  needsKind: TaskNeedKind
  canLevelTwo: boolean
  hasCan: boolean
}

export interface StaticTaskTemplate {
  label: string
  msg: string
  obj: 'Amusing' | 'Study' | 'Work' | 'Travel1' | 'Travel2'
  num: number
  keep?: boolean
  reroll?: number
  good?: string[]
}

/** Exact static task tables and daily-kind metadata mirrored from renderer tasks.ts. */
export const DAILY_TASK_TEMPLATES: DailyTaskTemplate[] = TASK_TABLES.kinds as unknown as DailyTaskTemplate[]
export const STATIC_TASKS: Record<'ddw' | 'growth' | 'travel', StaticTaskTemplate[]> = TASK_TABLES.tasks as unknown as Record<'ddw' | 'growth' | 'travel', StaticTaskTemplate[]>


export interface FryDefinition {
  fryid: number
  avator: number
  flag: number
  name: string
  level: number
  price_yb: number
  quantity: number
  interval: number
  sell_price: number
}

export interface FarmCropDefinition {
  seed: string
  name: string
  crop: string
  time: number
  experience: number
  yield: number
  price: number
}

export interface FarmSeedDefinition {
  seed: string
  name: string
  price: number
  rank: number
  maturation: number
  experience: number
  yield: number
  cropPrice: number
  type: string
}

export interface FarmFertilizerDefinition { item: string; name: string; duration: number }

export interface IslandFolkDefinition { key: string; scene: number; about: string }
export interface IslandMonsterDefinition { name: string; scene: number; about: string }
export interface IslandSpotDefinition { name: string }
export interface IslandContent {
  places: Record<string, string>
  folk: Record<string, IslandFolkDefinition>
  senders: string[]
  letters: number
  pieces: number
  tier: number
  facts: [string, string][]
  errands: [string, string, string, string][]
  monsters: Record<string, IslandMonsterDefinition>
  tactics: Record<string, 'strong' | 'intel' | 'charm'>
  spots: Record<string, IslandSpotDefinition>
  plays: Record<string, string>
  chores: Record<string, number>
  gifts: Record<string, string>
}

export const FRIES = FRIES_TABLE as unknown as FryDefinition[]
export const FARM_CROPS = (FARM as unknown as { crops: FarmCropDefinition[] }).crops
export const FARM_SEEDS = (FARM as unknown as { seeds: FarmSeedDefinition[] }).seeds
export const FARM_FERTILIZERS = (FARM as unknown as { fertilizers: FarmFertilizerDefinition[] }).fertilizers
export const ISLAND = ISLAND_TABLE as unknown as IslandContent


function collectStringLeaves(value: unknown, output: string[]): void {
  if (typeof value === 'string') { output.push(value); return }
  if (Array.isArray(value)) { for (const entry of value) collectStringLeaves(entry, output); return }
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) collectStringLeaves(entry, output)
  }
}

const shopIds: string[] = []
collectStringLeaves(SHOP_TABLE, shopIds)
export const SOLD_IDS = new Set<string>(shopIds)

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

export interface DailyTaskTemplate {
  obj: 'Eat' | 'Clean' | 'Toy' | 'Amusing' | 'Work' | 'Study' | 'GameRound' | 'Travel1'
  label: string
  num: [number, number]
  msg: [string, string]
}

export const DAILY_TASK_TEMPLATES: DailyTaskTemplate[] = [
  { obj: 'Eat', label: '喂我吃东西{n}次', num: [2, 4], msg: ['肚子咕咕叫啦，快给我吃点东西吧~', '吃饱饱才能长高~'] },
  { obj: 'Clean', label: '帮我洗香香{n}次', num: [1, 3], msg: ['身上脏脏的，好难受呀~', '香香的才招人喜欢~'] },
  { obj: 'Toy', label: '陪我玩玩具{n}次', num: [2, 4], msg: ['人家不开心，陪我玩一会儿嘛~', '一起玩最开心啦~'] },
  { obj: 'Amusing', label: '逗逗我{n}次', num: [10, 20], msg: ['心情不好，逗我笑一笑吧~', '点击逗乐点位'] },
  { obj: 'Work', label: '去打工{n}次', num: [1, 3], msg: ['家里没钱啦，我去打工赚元宝吧~', '勤劳致富，打工去咯~'] },
  { obj: 'Study', label: '去上学{n}次', num: [1, 2], msg: ['上学日要好好学习哦~', '书山有路勤为径~'] },
  { obj: 'GameRound', label: '玩{n}次小游戏', num: [1, 3], msg: ['陪我玩会儿游戏嘛~', '一起玩最开心~'] },
  { obj: 'Travel1', label: '去旅游{n}次', num: [1, 2], msg: ['想出去看看世界~', '旅行最棒啦~'] },
]

export interface StaticTaskTemplate {
  label: string
  msg: string
  obj: 'Amusing' | 'Study' | 'Work' | 'Travel1' | 'Travel2'
  num: number
  keep?: boolean
  reroll?: number
  good?: string[]
}

export const STATIC_TASKS: Record<'ddw' | 'growth' | 'travel', StaticTaskTemplate[]> = {
  ddw: [
    { label: '逗逗我~~', msg: '点击逗乐点位', obj: 'Amusing', num: 5, good: ['_102010001*1'] },
    { label: '逗逗我2~~', msg: '点击逗乐点位', obj: 'Amusing', num: 10, good: ['_10012002*1'] },
    { label: '逗逗我3~~', msg: '点击逗乐点位', obj: 'Amusing', num: 15, good: ['_10013004*1'] },
    { label: '逗逗我4~~', msg: '点击逗乐点位', obj: 'Amusing', num: 20, reroll: 1 },
    { label: '逗逗我5~~', msg: '点击逗乐点位', obj: 'Amusing', num: 25, reroll: 2 },
  ],
  growth: [
    { label: '好好学习~~', msg: '去上一节课吧~', obj: 'Study', num: 1, good: ['_102010001*1'] },
    { label: '勤学苦读~~', msg: '今天上3节课，学霸就是你~', obj: 'Study', num: 3, reroll: 1 },
    { label: '勤劳致富~~', msg: '去打一次工吧~', obj: 'Work', num: 1, good: ['_yb*50'] },
    { label: '打工达人~~', msg: '今天打工3次，元宝多多~', obj: 'Work', num: 3, reroll: 1 },
  ],
  travel: [
    { label: '每日1游~~', msg: '去旅游一次吧~', obj: 'Travel1', num: 1, good: ['_102010001*1'] },
    { label: '每日5游~~', msg: '见多识广哦~', obj: 'Travel1', num: 5, reroll: 2 },
    { label: '去5个不同的城市~~', msg: '游览5座不同的城市', obj: 'Travel2', num: 5, keep: true, good: ['_100010490*1'] },
    { label: '去10个不同的城市~~', msg: '游览10座不同的城市', obj: 'Travel2', num: 10, keep: true, good: ['_100010127*1'] },
    { label: '去15个不同的城市~~', msg: '游览15座不同的城市', obj: 'Travel2', num: 15, keep: true, good: ['_100010239*1', '_100010497*1'] },
    { label: '去20个不同的城市~~', msg: '游览20座不同的城市', obj: 'Travel2', num: 20, keep: true, good: ['_100010417*1', '_100010499*1', '_100020155*1'] },
    { label: '去25个不同的城市~~', msg: '游览25座不同的城市', obj: 'Travel2', num: 25, keep: true, good: ['_yb*1024', '_100020195*1', '_100020198*1', '_100020217*1'] },
    { label: '去30个不同的城市~~', msg: '游览30座不同的城市', obj: 'Travel2', num: 30, keep: true, good: ['_100010485*1', '_100020221*1', '_100010353*1', '_b0000006*1', '_b0000015*1'] },
    { label: '去35个不同的城市~~', msg: '游览35座不同的城市', obj: 'Travel2', num: 35, keep: true, good: ['_100010486*1', '_yb*2048', '_100020205*1', '_100020240*1', '_b0000016*1', '_60001*1'] },
  ],
}

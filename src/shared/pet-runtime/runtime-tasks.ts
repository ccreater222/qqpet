import type { SharedSaveData } from '../sync/data-boundary'
import type { CalendarInput } from './types'
import { DAILY_TASK_TEMPLATES, STATIC_TASKS, parseGoodCode, type StaticTaskTemplate } from './content/index'
import {
  addTaskCount,
  localDate,
  currentBoundarySeconds,
  lootGoods,
  readTaskProgress,
  writeTaskProgress,
  type RuntimeRng,
  type TaskDefinition,
  type TaskEntry,
  type TaskProgress,
  type TaskTab,
} from './runtime-helpers'
import type { RuntimeGood } from './content/index'

function rewardGoods(template: StaticTaskTemplate, rng: RuntimeRng): RuntimeGood[] {
  const fixed = (template.good ?? []).map(code => parseGoodCode(code)).filter((good): good is RuntimeGood => good !== null)
  const random = template.reroll ? lootGoods(rng, template.reroll) : []
  return [...random, ...fixed]
}

function entryFor(template: StaticTaskTemplate, rng: RuntimeRng): TaskEntry {
  return { take: false, good: rewardGoods(template, rng) }
}

function isWeekend(gameTimeMs: number, timeZone: string): boolean {
  const date = localDate(gameTimeMs, timeZone)
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
  return weekday === 0 || weekday === 6
}

export function dailyTaskIsOff(gameTimeMs: number, timeZone: string, calendarDay?: CalendarInput): boolean {
  if (calendarDay?.holiday) return calendarDay.holiday.off
  return isWeekend(gameTimeMs, timeZone)
}

export function dailyTaskNeeded(template: (typeof DAILY_TASK_TEMPLATES)[number], save: SharedSaveData, off: boolean): boolean {
  const caps = save.petComputedlInfo
  switch (template.needsKind) {
    case 'hungerLow': return save.petInfo.hunger < caps.hungerMax / 2
    case 'cleanLow': return save.petInfo.clean < caps.cleanMax / 2
    case 'moodLow': return save.petInfo.mood < 500
    case 'ybLow': return save.petInfo.yb < 500
    case 'studyDay': return off === false
    case 'dayOff': return off === true
  }
}

export function dailyTaskCandidates(save: SharedSaveData): (typeof DAILY_TASK_TEMPLATES)[number][] {
  return DAILY_TASK_TEMPLATES.filter(template =>
    template.hasCan === false || (template.canLevelTwo === true && save.petComputedlInfo.level >= 2),
  )
}

export function dailyTaskPool(save: SharedSaveData, off: boolean): (typeof DAILY_TASK_TEMPLATES)[number][] {
  return dailyTaskCandidates(save).flatMap(template =>
    Array.from({ length: dailyTaskNeeded(template, save, off) ? 3 : 1 }, () => template),
  )
}

export function rollDailyTasks(
  save: SharedSaveData,
  gameTimeMs: number,
  timeZone: string,
  rng: RuntimeRng,
  calendarDay?: CalendarInput,
): TaskDefinition[] {
  const off = dailyTaskIsOff(gameTimeMs, timeZone, calendarDay)
  const pool = dailyTaskPool(save, off)
  const daily: TaskDefinition[] = []
  while (daily.length < 4) {
    const template = pool[rng.randIntInclusive(0, pool.length - 1)]
    const num = rng.randIntInclusive(template.num[0], template.num[1])
    if (daily.some(task => task.obj === template.obj)) continue
    daily.push({
      label: template.label.replace('{n}', String(num)),
      msg: template.msg[dailyTaskNeeded(template, save, off) ? 0 : 1],
      obj: template.obj,
      num,
      reroll: 1,
      good: ['_yb*' + String(rng.randIntInclusive(2, 5) * 10)],
    })
  }
  const holiday = calendarDay?.holiday
  if (holiday?.off) {
    daily.push({
      label: holiday.name + '快乐',
      msg: '过节啦，陪我玩5次玩具一起庆祝吧~',
      obj: 'Toy',
      num: 5,
      reroll: 2,
      good: ['_yb*100'],
    })
  }
  const progress = readTaskProgress(save)
  progress.daily = daily
  progress.dailyDay = currentBoundarySeconds(gameTimeMs, timeZone)
  progress.taskList.daily = daily.map(task => {
    const fixed = (task.good ?? []).map(code => parseGoodCode(code)).filter((good): good is RuntimeGood => good !== null)
    const random = task.reroll ? lootGoods(rng, task.reroll) : []
    return { take: false, good: [...random, ...fixed] }
  })
  writeTaskProgress(save, progress)
  return daily
}


export function buildResetStaticTaskLists(
  previous: TaskProgress,
  rng: RuntimeRng,
): Record<'ddw' | 'growth' | 'travel', TaskEntry[]> {
  const tabs = ['ddw', 'growth', 'travel'] as const
  const loaded = {} as Record<'ddw' | 'growth' | 'travel', TaskEntry[]>
  for (const tab of tabs) {
    loaded[tab] = STATIC_TASKS[tab].map((template, index) => {
      const existing = previous.taskList[tab][index]
      return existing ?? entryFor(template, rng)
    })
  }
  const reset = {} as Record<'ddw' | 'growth' | 'travel', TaskEntry[]>
  for (const tab of tabs) {
    reset[tab] = STATIC_TASKS[tab].map((template, index) => {
      const entry = loaded[tab][index]
      return {
        take: template.keep === true ? entry.take : false,
        good: template.reroll ? rewardGoods(template, rng) : entry.good,
      }
    })
  }
  return reset
}

export function resetDailyTasks(
  save: SharedSaveData,
  gameTimeMs: number,
  timeZone: string,
  rng: RuntimeRng,
  calendarDay?: CalendarInput,
): { previous: TaskProgress; next: TaskProgress; daily: TaskDefinition[] } {
  const previous = readTaskProgress(save)
  const next: TaskProgress = {
    doNums: {},
    taskList: { daily: [], ...buildResetStaticTaskLists(previous, rng) },
    daily: previous.daily,
    dailyDay: previous.dailyDay,
  }
  writeTaskProgress(save, next)
  const daily = rollDailyTasks(save, gameTimeMs, timeZone, rng, calendarDay)
  return { previous, next: readTaskProgress(save), daily }
}

export function counterValue(save: SharedSaveData, counter: TaskDefinition['obj']): number {
  if (counter === 'Travel2') return save.gameSaveDatas.travel_china.length
  return readTaskProgress(save).doNums[counter] ?? 0
}

export function claimTask(
  save: SharedSaveData,
  tab: TaskTab,
  index: number,
): { definition: TaskDefinition; goods: RuntimeGood[]; entry: TaskEntry } | null {
  const progress = readTaskProgress(save)
  const definitions: TaskDefinition[] = tab === 'daily'
    ? progress.daily
    : STATIC_TASKS[tab].map(template => ({
        label: template.label,
        msg: template.msg,
        obj: template.obj,
        num: template.num,
        keep: template.keep,
        reroll: template.reroll,
        good: template.good,
      }))
  const definition = definitions[index]
  const entry = progress.taskList[tab][index]
  if (definition === undefined || entry === undefined) return null
  if (entry.take) return null
  if (counterValue(save, definition.obj) < definition.num) return null
  entry.take = true
  writeTaskProgress(save, progress)
  return { definition, goods: entry.good, entry }
}

export function incrementCounter(save: SharedSaveData, counter: Parameters<typeof addTaskCount>[1]): void {
  addTaskCount(save, counter, 1)
}

export function taskDefinitionAt(progress: TaskProgress, tab: TaskTab, index: number): TaskDefinition | undefined {
  if (tab === 'daily') return progress.daily[index]
  const template = STATIC_TASKS[tab][index]
  if (template === undefined) return undefined
  return {
    label: template.label,
    msg: template.msg,
    obj: template.obj,
    num: template.num,
    keep: template.keep,
    reroll: template.reroll,
    good: template.good,
  }
}

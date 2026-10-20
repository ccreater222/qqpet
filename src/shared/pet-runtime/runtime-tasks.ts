import type { SharedSaveData } from '../sync/data-boundary'
import { DAILY_TASK_TEMPLATES, STATIC_TASKS, parseGoodCode, type StaticTaskTemplate } from './content/index'
import {
  addTaskCount,
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

function dailyDefinition(template: (typeof DAILY_TASK_TEMPLATES)[number], num: number, rng: RuntimeRng): TaskDefinition {
  const msgIndex = rng.randIntInclusive(0, 1)
  return {
    label: template.label.replace('{n}', String(num)),
    msg: template.msg[msgIndex],
    obj: template.obj,
    num,
    reroll: 1,
    good: ['_yb*' + String(rng.randIntInclusive(2, 5) * 10)],
  }
}

export function rollDailyTasks(save: SharedSaveData, gameTimeMs: number, timeZone: string, rng: RuntimeRng): TaskDefinition[] {
  const templates = rng.shuffle(DAILY_TASK_TEMPLATES).slice(0, 3)
  const daily: TaskDefinition[] = []
  for (let index = 0; index < templates.length; index++) {
    const template = templates[index]
    const num = rng.randIntInclusive(template.num[0], template.num[1])
    daily.push(dailyDefinition(template, num, rng))
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

export function resetDailyTasks(
  save: SharedSaveData,
  gameTimeMs: number,
  timeZone: string,
  rng: RuntimeRng,
): { previous: TaskProgress; next: TaskProgress; daily: TaskDefinition[] } {
  const previous = readTaskProgress(save)
  const next: TaskProgress = {
    doNums: {},
    taskList: {
      daily: [],
      ddw: previous.taskList.ddw.map((entry, index) => {
        const template = STATIC_TASKS.ddw[index]
        if (template === undefined) return entry
        return {
          take: template.keep === true ? entry.take : false,
          good: template.reroll ? rewardGoods(template, rng) : entry.good,
        }
      }),
      growth: previous.taskList.growth.map((entry, index) => {
        const template = STATIC_TASKS.growth[index]
        if (template === undefined) return entry
        return {
          take: template.keep === true ? entry.take : false,
          good: template.reroll ? rewardGoods(template, rng) : entry.good,
        }
      }),
      travel: previous.taskList.travel.map((entry, index) => {
        const template = STATIC_TASKS.travel[index]
        if (template === undefined) return entry
        return {
          take: template.keep === true ? entry.take : false,
          good: template.reroll ? rewardGoods(template, rng) : entry.good,
        }
      }),
    },
    daily: previous.daily,
    dailyDay: previous.dailyDay,
  }
  for (const tab of ['ddw', 'growth', 'travel'] as const) {
    next.taskList[tab] = STATIC_TASKS[tab].map((template, index) => {
      const existing = next.taskList[tab][index]
      if (existing !== undefined) return existing
      const entry = entryFor(template, rng)
      return template.keep ? { ...entry, take: true } : entry
    })
  }
  writeTaskProgress(save, next)
  const daily = rollDailyTasks(save, gameTimeMs, timeZone, rng)
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

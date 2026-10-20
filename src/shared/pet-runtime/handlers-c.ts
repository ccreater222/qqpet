import type { CommandPayloadMap } from '../sync/protocol'
import type { SharedSaveData } from '../sync/data-boundary'
import { TRAVEL_PROVINCES, WORK_GOODS, STUDY_GOODS, type RuntimeGood } from './content/index'
import { domainEvent } from './events'
import {
  cancelPendingJobs,
  clearAllActivities,
  grantGoods,
  isBusy,
  readTaskProgress,
  reject,
  requireLivingPet,
  requireNotPaused,
  scheduleJob,
  writeSharedBlob,
  writeTaskProgress,
} from './runtime-helpers'
import { counterValue, taskDefinitionAt } from './runtime-tasks'
import { answerIslandQuiz, startExam, startIslandQuiz, submitExam, type SessionHandlerOutcome } from './sessions'
import type { HandlerContext, HandlerResult } from './handler-types'
import type { JsonObject, JsonValue } from './types'

function json<T>(value: T): JsonValue {
  return value as unknown as JsonValue
}

function payloadJson(value: Record<string, string | number>): JsonObject {
  return value as JsonObject
}

function cannotStartActivity(save: SharedSaveData): string | null {
  if (save.petInfo.health === 0) return 'pet_dead'
  if (save.petInfo.health !== 5) return 'not_available'
  if (save.settings.paused) return 'paused'
  if (save.petInfo.mood <= 0) return 'not_available'
  if (isBusy(save)) return 'busy'
  return null
}

function rejectActivityBlocker(code: string): never {
  if (code === 'pet_dead') reject('pet_dead', 'the pet is dead')
  if (code === 'paused') reject('paused', 'the pet is paused')
  if (code === 'busy') reject('busy', 'the pet is already busy')
  reject('not_available', 'the pet cannot start this activity')
}

export function startWork(context: HandlerContext, payload: CommandPayloadMap['job.startWork']): HandlerResult {
  requireLivingPet(context.state)
  requireNotPaused(context.state)
  const blocker = cannotStartActivity(context.state.save)
  if (blocker !== null) rejectActivityBlocker(blocker)
  const good = WORK_GOODS.find(candidate => candidate.id === payload.jobId)
  if (good === undefined) reject('not_available', 'unknown work')
  const save = context.state.save
  if ((good.needLevel ?? 0) > save.petComputedlInfo.level) reject('not_available', 'pet level is too low')
  for (const [stat, required] of Object.entries(good.useArtt ?? {})) {
    if ((save.petInfo[stat as 'charm' | 'intel' | 'strong'] ?? 0) < required) reject('not_available', 'pet stat requirement is not met')
  }
  for (const [subject, required] of Object.entries(good.education ?? {})) {
    if ((save.studyInfo[subject as keyof typeof save.studyInfo] ?? 0) < required) reject('not_available', 'education requirement is not met')
  }
  const minutes = good.useTime ?? 0
  if (minutes <= 0) reject('not_available', 'invalid work duration')
  save.activeOption.work = good.id
  writeSharedBlob(save, 'activity', 0)
  const dueAtGameMs = context.ctx.gameTimeMs + minutes * 60_000
  const job = scheduleJob(context.state, 'work', dueAtGameMs, payloadJson({
    activityKind: 'work', activityId: good.id, startedAtGameMs: context.ctx.gameTimeMs,
  }))
  return {
    result: json({ jobId: job.id, activityId: good.id, dueAtGameMs }),
    events: [domainEvent('activity.started', { kind: 'work', activityId: good.id, dueAtGameMs })],
  }
}

export function startStudy(context: HandlerContext, payload: CommandPayloadMap['job.startStudy']): HandlerResult {
  requireLivingPet(context.state)
  requireNotPaused(context.state)
  const blocker = cannotStartActivity(context.state.save)
  if (blocker !== null) rejectActivityBlocker(blocker)
  const good = STUDY_GOODS.find(candidate => candidate.id === payload.courseId)
  if (good === undefined) reject('not_available', 'unknown course')
  const subject = (good as RuntimeGood & { value?: string }).value as keyof typeof context.state.save.studyInfo | undefined
  if (subject === undefined || Object.prototype.hasOwnProperty.call(context.state.save.studyInfo, subject) === false) {
    reject('not_available', 'unknown study subject')
  }
  const lessons = context.state.save.studyInfo[subject] - (good.classNumUp ?? 0)
  if (lessons >= (good.classNum ?? 0)) reject('not_available', 'the course is ready for its exam')
  const minutes = good.useTime ?? 0
  if (minutes <= 0) reject('not_available', 'invalid course duration')
  let duration = minutes
  const threshold = Math.max(200, Math.floor(3000 - context.state.save.petInfo.intel / 10))
  for (let done = Math.max(1, minutes - 4); done <= minutes; done++) {
    if (context.rng.randIntInclusive(0, threshold) <= 10) {
      duration = done
      break
    }
  }
  context.state.save.activeOption.study = good.id
  writeSharedBlob(context.state.save, 'activity', 0)
  const dueAtGameMs = context.ctx.gameTimeMs + duration * 60_000
  const job = scheduleJob(context.state, 'study', dueAtGameMs, payloadJson({
    activityKind: 'study', activityId: good.id, startedAtGameMs: context.ctx.gameTimeMs, early: duration < minutes ? 1 : 0,
  }))
  return {
    result: json({ jobId: job.id, courseId: good.id, dueAtGameMs, early: duration < minutes }),
    events: [domainEvent('activity.started', { kind: 'study', activityId: good.id, dueAtGameMs, early: duration < minutes })],
  }
}

export function startTravel(context: HandlerContext): HandlerResult {
  requireLivingPet(context.state)
  requireNotPaused(context.state)
  const blocker = cannotStartActivity(context.state.save)
  if (blocker !== null) rejectActivityBlocker(blocker)
  if (TRAVEL_PROVINCES.length === 0) reject('not_available', 'no travel destinations')
  const province = TRAVEL_PROVINCES[context.rng.randIntInclusive(0, TRAVEL_PROVINCES.length - 1)]
  context.state.save.activeOption.trip = province.name
  writeSharedBlob(context.state.save, 'activity', 0)
  const dueAtGameMs = context.ctx.gameTimeMs + 60 * 60_000
  const job = scheduleJob(context.state, 'travel', dueAtGameMs, payloadJson({
    activityKind: 'travel', activityId: province.name, startedAtGameMs: context.ctx.gameTimeMs,
    plannedMinutes: 60,
  }))
  return {
    result: json({ jobId: job.id, destination: province.name, dueAtGameMs }),
    events: [domainEvent('activity.started', { kind: 'travel', activityId: province.name, dueAtGameMs })],
  }
}

export function stopActivity(context: HandlerContext): HandlerResult {
  requireLivingPet(context.state)
  const save = context.state.save
  const kind = save.activeOption.work !== null ? 'work'
    : save.activeOption.study !== null ? 'study'
      : save.activeOption.trip !== null ? 'trip' : null
  if (kind === null) reject('not_available', 'no activity is running')
  const jobKind = kind === 'trip' ? 'travel' : kind
  cancelPendingJobs(context.state, job => job.payload.activityKind === jobKind)
  clearAllActivities(save)
  return {
    result: json({ stopped: kind }),
    events: [domainEvent('activity.completed', { kind, cancelled: true })],
  }
}

export function claimTaskReward(context: HandlerContext, payload: CommandPayloadMap['task.claim']): HandlerResult {
  requireLivingPet(context.state)
  const save = context.state.save
  const progress = readTaskProgress(save)
  const definition = taskDefinitionAt(progress, payload.tab, payload.index)
  const entry = progress.taskList[payload.tab][payload.index]
  if (definition === undefined || entry === undefined) reject('not_available', 'unknown task')
  if (entry.take) reject('already_claimed', 'task reward has already been claimed')
  const done = definition.obj === 'Travel2' ? save.gameSaveDatas.travel_china.length : counterValue(save, definition.obj)
  if (done < definition.num) reject('not_available', 'task is not complete')
  entry.take = true
  writeTaskProgress(save, progress)
  grantGoods(save, entry.good)
  return {
    result: json({ tab: payload.tab, index: payload.index, goods: entry.good.map(good => ({ id: good.id, type: good.type, num: good.num })) }),
    events: [
      domainEvent('task.claimed', { tab: payload.tab, index: payload.index, counter: definition.obj }),
      domainEvent('reward.granted', { source: 'task', count: entry.good.length }),
    ],
  }
}

export function examStart(context: HandlerContext, payload: CommandPayloadMap['exam.start']): SessionHandlerOutcome {
  return startExam(context.state, payload, context.ctx, context.rng)
}

export function examSubmit(context: HandlerContext, payload: CommandPayloadMap['exam.submit']): SessionHandlerOutcome {
  return submitExam(context.state, payload, context.ctx)
}

export function islandQuizStart(context: HandlerContext, payload: CommandPayloadMap['island.startQuiz']): SessionHandlerOutcome {
  return startIslandQuiz(context.state, payload, context.ctx, context.rng)
}

export function islandQuizAnswer(context: HandlerContext, payload: CommandPayloadMap['island.answerQuiz']): SessionHandlerOutcome {
  return answerIslandQuiz(context.state, payload, context.ctx, context.rng)
}

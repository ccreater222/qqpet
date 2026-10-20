import type { CommandPayloadMap } from '../sync/protocol'
import { projectExamSession, projectIslandQuizSession } from '../sync/session-projection'
import { EXAM_BANK } from './content/index'
import { domainEvent, type DomainEvent } from './events'
import { stageOf } from './level'
import {
  cancelSessionJob,
  findSession,
  currentGrowthPerMinute,
  grantGoods,
  isBusy,
  lootGoods,
  reject,
  requireLivingPet,
  scheduleJob,
  writeIsland,
  addTaskCount,
  readTaskProgress,
  type RuntimeRng,
} from './runtime-helpers'
import type { EngineState, GameSessionPayload, GameSessionState, JsonObject, JsonValue } from './types'
import type { RuntimeCommandContext } from './runtime-types'
import { applyGood, readIsland } from './runtime-helpers'
import { STUDY_GOODS, goodOf, type RuntimeGood } from './content/index'

const GAME_SESSION_MS = 60 * 60_000
const DIUDIULE_SESSION_MS = 5 * 60_000
const EXAM_SESSION_MS = 30 * 60_000
const ISLAND_QUIZ_SESSION_MS = 10 * 60_000

export interface SessionHandlerOutcome {
  result?: JsonValue
  events: DomainEvent[]
}

function event(type: string, payload: JsonObject): DomainEvent {
  return domainEvent(type, payload)
}

function json<T>(value: T): JsonValue {
  return value as unknown as JsonValue
}

function requireActor(ctx: RuntimeCommandContext): string {
  if (ctx.actorDeviceId === null || ctx.actorDeviceId.length === 0) reject('unauthorized', 'an authenticated actor is required')
  return ctx.actorDeviceId
}

function issueToken(state: EngineState, rng: RuntimeRng): string {
  for (let attempt = 0; attempt < 32; attempt++) {
    const token = rng.tokenHex()
    if (findSession(state, token) === undefined) return token
  }
  reject('internal', 'could not issue a unique session token')
}

function startSession(
  state: EngineState,
  ctx: RuntimeCommandContext,
  rng: RuntimeRng,
  payload: GameSessionPayload,
  timeoutMs: number,
): GameSessionState {
  const token = issueToken(state, rng)
  const startedAtGameMs = ctx.gameTimeMs
  const session: GameSessionState = {
    sessionToken: token,
    actorDeviceId: requireActor(ctx),
    payload,
    startedAtGameMs,
    expiresAtGameMs: startedAtGameMs + timeoutMs,
    status: 'active',
  }
  state.gameSessions.push(session)
  scheduleJob(state, 'game-session', session.expiresAtGameMs, { sessionToken: token, kind: payload.kind })
  return session
}

function requireActiveSession(
  state: EngineState,
  token: string,
  actorDeviceId: string,
  expectedKind: GameSessionPayload['kind'],
  nowMs: number,
): GameSessionState {
  const session = findSession(state, token)
  if (session === undefined) reject('not_available', 'unknown session token')
  if (session.actorDeviceId !== actorDeviceId) reject('unauthorized', 'session belongs to another device')
  if (session.payload.kind !== expectedKind) reject('wrong_phase', 'session kind does not match this command')
  if (session.status !== 'active') reject('already_claimed', 'session is no longer active')
  if (nowMs >= session.expiresAtGameMs) reject('not_available', 'session has expired')
  return session
}

function requirePlayable(state: EngineState, ctx: RuntimeCommandContext): void {
  requireLivingPet(state)
  if (state.save.settings.paused) reject('paused', 'the pet is paused')
  const stage = stageOf(state.save.petComputedlInfo.level)
  if (stage === 'Egg') reject('not_available', 'the pet is still an egg')
  if (isBusy(state.save)) reject('busy', 'the pet is busy')
  requireActor(ctx)
}

export function startGameSession(
  state: EngineState,
  payload: CommandPayloadMap['game.startSession'],
  ctx: RuntimeCommandContext,
  rng: RuntimeRng,
): SessionHandlerOutcome {
  requirePlayable(state, ctx)
  const session = startSession(state, ctx, rng, {
    kind: 'game',
    gameId: payload.gameId,
    gameKind: payload.kind,
    presentationSeed: rng.tokenHex(),
  }, GAME_SESSION_MS)
  return {
    result: json({ sessionToken: session.sessionToken, gameId: payload.gameId }),
    events: [event('game.sessionStarted', { gameId: payload.gameId, gameKind: payload.kind, expiresAtGameMs: session.expiresAtGameMs })],
  }
}

export function rewardGameSession(
  state: EngineState,
  payload: CommandPayloadMap['game.reward'],
  ctx: RuntimeCommandContext,
): SessionHandlerOutcome {
  const actor = requireActor(ctx)
  const session = requireActiveSession(state, payload.sessionToken, actor, 'game', ctx.gameTimeMs)
  const minutes = Math.min(60, Math.max(0, Math.floor((ctx.gameTimeMs - session.startedAtGameMs) / 60_000)))
  const task = readTaskProgress(state.save)
  const remaining = Math.max(0, 60 - (task.doNums.Game ?? 0))
  const effectiveMinutes = Math.min(minutes, remaining)
  const yb = effectiveMinutes === 0 ? 0 : earnGameYb(state, 5 * effectiveMinutes)
  const growth = effectiveMinutes === 0 ? 0 : Number((currentGrowthPerMinute(state.save) * effectiveMinutes).toFixed(8))
  state.save.petInfo.growth += growth
  state.save.petInfo.mood = Math.min(state.save.petComputedlInfo.moodMax, state.save.petInfo.mood + 2 * effectiveMinutes)
  addTaskCount(state.save, 'GameRound', 1)
  if (effectiveMinutes > 0) addTaskCount(state.save, 'Game', effectiveMinutes)
  session.status = 'settled'
  session.rewardKey = 'game'
  cancelSessionJob(state, session.sessionToken)
  return {
    result: json({ minutes: effectiveMinutes, yb, growth, mood: 2 * effectiveMinutes, gameRound: 1 }),
    events: [
      event('game.sessionSettled', { gameId: session.payload.kind === 'game' ? session.payload.gameId : '', minutes: effectiveMinutes, yb, growth }),
      event('task.progress', { counter: 'GameRound', amount: 1 }),
    ],
  }
}

function earnGameYb(state: EngineState, amount: number): number {
  const got = state.save.settings.difficulty === 'standard' ? Math.max(1, Math.round(amount * 0.4)) : amount
  state.save.petInfo.yb += got
  return got
}

export function startDiudiuleSession(
  state: EngineState,
  ctx: RuntimeCommandContext,
  rng: RuntimeRng,
): SessionHandlerOutcome {
  requirePlayable(state, ctx)
  if (state.save.petInfo.health !== 5) reject('not_available', 'the pet is too ill to play diudiule')
  const session = startSession(state, ctx, rng, { kind: 'diudiule' }, DIUDIULE_SESSION_MS)
  return {
    result: json({ sessionToken: session.sessionToken }),
    events: [event('game.sessionStarted', { gameId: 'diudiule', gameKind: 'diudiule', expiresAtGameMs: session.expiresAtGameMs })],
  }
}

export function rewardDiudiuleSession(
  state: EngineState,
  payload: CommandPayloadMap['diudiule.reward'],
  ctx: RuntimeCommandContext,
): SessionHandlerOutcome {
  const actor = requireActor(ctx)
  const session = requireActiveSession(state, payload.sessionToken, actor, 'diudiule', ctx.gameTimeMs)
  const mood = Math.min(55, Math.max(0, state.save.petComputedlInfo.moodMax - state.save.petInfo.mood))
  state.save.petInfo.mood += mood
  const yb = 1
  state.save.petInfo.yb += yb
  session.status = 'settled'
  session.rewardKey = 'diudiule'
  cancelSessionJob(state, session.sessionToken)
  return {
    result: json({ mood, yb }),
    events: [event('game.sessionSettled', { gameId: 'diudiule', mood, yb })],
  }
}

export function startExam(
  state: EngineState,
  payload: CommandPayloadMap['exam.start'],
  ctx: RuntimeCommandContext,
  rng: RuntimeRng,
): SessionHandlerOutcome {
  requireLivingPet(state)
  requireActor(ctx)
  if (state.save.settings.paused) reject('paused', 'the pet is paused')
  if (isBusy(state.save)) reject('busy', 'the pet is busy')
  const bank = EXAM_BANK[payload.subject]
  const study = STUDY_GOODS.find(good => good.id === payload.subject)
  if (bank === undefined || bank.length === 0 || study === undefined) reject('not_available', 'unknown exam subject')
  const subject = typeof study.value === 'string' ? study.value as keyof typeof state.save.studyInfo : undefined
  if (subject === undefined || Object.prototype.hasOwnProperty.call(state.save.studyInfo, subject) === false) {
    reject('not_available', 'unknown study subject')
  }
  const lessons = state.save.studyInfo[subject] - (study.classNumUp ?? 0)
  if (lessons < (study.classNum ?? 0)) reject('not_available', 'the course is not ready for its exam')
  const chosen = rng.shuffle(bank.map((question, index) => ({ question, index }))).slice(0, 3).map(({ question, index }) => {
    const options = rng.shuffle(question.options)
    const answerIndex = options.indexOf(question.answer)
    if (answerIndex < 0) reject('internal', 'exam answer is missing from its options')
    return {
      questionId: payload.subject + ':' + index,
      prompt: question.title,
      options,
      answerIndex,
    }
  })
  const session = startSession(state, ctx, rng, {
    kind: 'exam',
    subject: payload.subject,
    questions: chosen,
    examMetadata: { lesson: lessons, school: payload.subject.split('-')[0] ?? '' },
  }, EXAM_SESSION_MS)
  return {
    result: json(projectExamSession(session)),
    events: [event('activity.started', { kind: 'exam', subject: payload.subject, expiresAtGameMs: session.expiresAtGameMs })],
  }
}

export function submitExam(
  state: EngineState,
  payload: CommandPayloadMap['exam.submit'],
  ctx: RuntimeCommandContext,
): SessionHandlerOutcome {
  const actor = requireActor(ctx)
  const session = requireActiveSession(state, payload.sessionToken, actor, 'exam', ctx.gameTimeMs)
  const exam = session.payload
  if (exam.kind !== 'exam') reject('wrong_phase', 'session kind mismatch')
  if (payload.answers.length !== exam.questions.length) reject('invalid_payload', 'all questions require an answer')
  const answers = payload.answers
  for (let index = 0; index < answers.length; index++) {
    const answer = answers[index]
    if (Number.isSafeInteger(answer) === false || answer < 0 || answer >= exam.questions[index].options.length) {
      reject('invalid_payload', 'answer index is outside the options')
    }
  }
  const correctCount = exam.questions.reduce((count, question, index) => count + Number(answers[index] === question.answerIndex), 0)
  const passed = correctCount === exam.questions.length
  const study = STUDY_GOODS.find(good => good.id === exam.subject)
  if (study !== undefined) {
    const subject = typeof study.value === 'string' ? study.value as keyof typeof state.save.studyInfo : undefined
    if (passed && subject !== undefined) state.save.studyInfo[subject] += 1
    if (passed) applyGood(state.save, study)
  }
  session.status = 'settled'
  session.rewardKey = passed ? 'exam-pass' : 'exam-fail'
  cancelSessionJob(state, session.sessionToken)
  return {
    result: json({ passed, correctCount, total: exam.questions.length }),
    events: [event('activity.completed', { kind: 'exam', subject: exam.subject, passed, correctCount, total: exam.questions.length })],
  }
}

function findQuizErrand(state: EngineState, npcId: string, errandId: string): { island: ReturnType<typeof readIsland>; index: number } {
  const island = readIsland(state.save, state.gameTimeMs)
  const index = island.errands.findIndex((errand, candidate) =>
    errand.from === npcId && (
      errand.kind === errandId ||
      errand.from + ':' + errand.kind === errandId ||
      String(candidate) === errandId
    ),
  )
  if (index < 0) reject('not_available', 'island errand was not found')
  return { island, index }
}

export function startIslandQuiz(
  state: EngineState,
  payload: CommandPayloadMap['island.startQuiz'],
  ctx: RuntimeCommandContext,
  rng: RuntimeRng,
): SessionHandlerOutcome {
  requireLivingPet(state)
  requireActor(ctx)
  const { island, index } = findQuizErrand(state, payload.npcId, payload.errandId)
  const errand = island.errands[index]
  if (errand.kind !== 'quiz') reject('wrong_phase', 'this errand is not a quiz')
  if (errand.got > 0 || errand.took) reject('already_claimed', 'the quiz errand is already complete')
  const bank = EXAM_BANK[errand.to]
  if (bank === undefined || bank.length === 0) reject('not_available', 'no quiz bank for this errand')
  const questionIndex = Math.floor((Math.floor(ctx.gameTimeMs / 1000)) / 86_400) % bank.length
  const question = bank[questionIndex]
  const options = rng.shuffle(question.options)
  const answerIndex = options.indexOf(question.answer)
  if (answerIndex < 0) reject('internal', 'quiz answer is missing from its options')
  const payloadSession = {
    kind: 'island_quiz' as const,
    quizKind: errand.to,
    recordId: errand.to + ':' + questionIndex,
    prompt: question.title,
    options,
    answerIndex,
    metadata: { npcId: payload.npcId, errandId: payload.errandId, islandErrandIndex: index },
  }
  const session = startSession(state, ctx, rng, payloadSession, ISLAND_QUIZ_SESSION_MS)
  return {
    result: json(projectIslandQuizSession(session)),
    events: [event('island.errandChanged', { npcId: payload.npcId, errandId: payload.errandId, status: 'quiz_started' })],
  }
}

export function answerIslandQuiz(
  state: EngineState,
  payload: CommandPayloadMap['island.answerQuiz'],
  ctx: RuntimeCommandContext,
  rng: RuntimeRng,
): SessionHandlerOutcome {
  const actor = requireActor(ctx)
  const session = requireActiveSession(state, payload.sessionToken, actor, 'island_quiz', ctx.gameTimeMs)
  const quiz = session.payload
  if (quiz.kind !== 'island_quiz') reject('wrong_phase', 'session kind mismatch')
  if (payload.optionIndex < 0 || payload.optionIndex >= quiz.options.length) reject('invalid_payload', 'option index is outside the options')
  const correct = payload.optionIndex === quiz.answerIndex
  const island = readIsland(state.save, ctx.gameTimeMs)
  const index = Number(quiz.metadata.islandErrandIndex ?? -1)
  const errand = Number.isSafeInteger(index) ? island.errands[index] : undefined
  let goods: RuntimeGood[] = []
  if (errand !== undefined) {
    errand.took = true
    if (correct) {
      errand.got = Math.max(errand.got, 1)
      goods = [goodOf('nums', 'yb', rng.randIntInclusive(5, 15) * 10)]
      if (rng.chance(0.3)) goods.push(...lootGoods(rng, 1))
      grantGoods(state.save, goods)
    }
    writeIsland(state.save, island)
  }
  session.status = 'settled'
  session.rewardKey = correct ? 'island-quiz-pass' : 'island-quiz-fail'
  cancelSessionJob(state, session.sessionToken)
  return {
    result: json({ correct, goods: goods.map(good => ({ id: good.id, type: good.type, num: good.num })) }),
    events: [
      event('island.errandChanged', { npcId: String(quiz.metadata.npcId ?? ''), errandId: String(quiz.metadata.errandId ?? ''), status: correct ? 'quiz_passed' : 'quiz_failed' }),
      ...(correct ? [event('island.rewardGranted', { yb: goods[0]?.num ?? 0 })] : []),
    ],
  }
}

export function abandonSession(
  state: EngineState,
  payload: CommandPayloadMap['game.abandonSession'],
  ctx: RuntimeCommandContext,
): SessionHandlerOutcome {
  const actor = requireActor(ctx)
  const session = findSession(state, payload.sessionToken)
  if (session === undefined) reject('not_available', 'unknown session token')
  if (session.status !== 'active') reject('already_claimed', 'session is no longer active')
  if (session.actorDeviceId !== actor && ctx.actorRole !== 'owner') reject('unauthorized', 'session belongs to another device')
  session.status = 'abandoned'
  session.cancelReason = 'actor_abandoned'
  cancelSessionJob(state, session.sessionToken)
  return {
    result: json({ sessionToken: session.sessionToken, status: 'abandoned' }),
    events: [event('game.sessionSettled', { kind: session.payload.kind, status: 'abandoned' })],
  }
}

export function expireSessionJobs(
  state: EngineState,
  nowMs: number,
): DomainEvent[] {
  const events: DomainEvent[] = []
  for (const job of state.scheduledJobs) {
    if (job.status !== 'pending' || job.type !== 'game-session' || job.dueAtGameMs > nowMs) continue
    job.status = 'completed'
    const token = typeof job.payload.sessionToken === 'string' ? job.payload.sessionToken : ''
    const session = findSession(state, token)
    if (session !== undefined && session.status === 'active') {
      session.status = 'expired'
      session.cancelReason = 'deadline_expired'
      events.push(event('game.sessionSettled', { kind: session.payload.kind, status: 'expired' }))
    }
  }
  return events
}

/** Rebinds one active session to a new actor device; pure and explicit for handoff/import flows. */
export function rebindSessionActor(
  state: EngineState,
  sessionToken: string,
  actorDeviceId: string,
): EngineState {
  if (actorDeviceId.length === 0) throw new Error('actorDeviceId must not be empty')
  const candidate = JSON.parse(JSON.stringify(state)) as EngineState
  const session = findSession(candidate, sessionToken)
  if (session === undefined) throw new Error('unknown session token')
  if (session.status !== 'active') throw new Error('session is not active')
  session.actorDeviceId = actorDeviceId
  return candidate
}

/** Applies the portable-import actor policy: rebind matching local sessions or cancel them without reward. */
export function rebindOrCancelImportedSessions(
  state: EngineState,
  options: { localActorDeviceId: string; newActorDeviceId: string; rebindLocalSessions: boolean; nowMs: number },
): EngineState {
  const candidate = JSON.parse(JSON.stringify(state)) as EngineState
  for (const session of candidate.gameSessions) {
    if (session.status !== 'active') continue
    if (session.expiresAtGameMs <= options.nowMs) {
      session.status = 'expired'
      session.cancelReason = 'deadline_expired'
      cancelSessionJob(candidate, session.sessionToken)
      continue
    }
    if (session.actorDeviceId !== options.localActorDeviceId) continue
    if (options.rebindLocalSessions) {
      session.actorDeviceId = options.newActorDeviceId
    } else {
      session.status = 'abandoned'
      session.cancelReason = 'import_actor_unavailable'
      cancelSessionJob(candidate, session.sessionToken)
    }
  }
  return candidate
}

export function sessionPublicSummary(session: GameSessionState): JsonObject {
  return {
    kind: session.payload.kind,
    status: session.status,
    startedAtGameMs: session.startedAtGameMs,
    expiresAtGameMs: session.expiresAtGameMs,
  }
}

export const rebindLocalSessionActor = rebindSessionActor
export const reconcileImportedSessionActors = rebindOrCancelImportedSessions

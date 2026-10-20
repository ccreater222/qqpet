import type { CommandKey, PetCommand } from '../sync/protocol'
import { assertEngineState } from '../sync/portable'
import { commandRole, isCommandKey, validateCommandPayload } from '../sync/command-validation'
import type { DomainEvent } from './events'
import { cloneEngine, createRuntimeRng, recomputePetComputed, reject, RuntimeFailure } from './runtime-helpers'
import type { RuntimeOutcome, RuntimeCommandContext, HeadlessRuntimeOptions } from './runtime-types'
import type { EngineState, JsonValue, RuntimeContext } from './types'
import type { HandlerContext, HandlerResult } from './handler-types'
import {
  adoptPet,
  buryPet,
  cheerPet,
  pokeFace,
  renamePet,
  resetPet,
  setPetPaused,
} from './handlers-a'
import {
  buyInventoryItem,
  buyPinkDiamond,
  buySweetheart,
  clearPinkDiamond,
  completeTravelCollection,
  medicalTreat,
  setSweetheart,
  useInventoryItem,
} from './handlers-b'
import {
  claimTaskReward,
  examStart,
  examSubmit,
  islandQuizAnswer,
  islandQuizStart,
  startStudy,
  startTravel,
  startWork,
  stopActivity,
} from './handlers-c'
import {
  claimAllMail,
  claimBirthdayGift,
  claimMail,
  claimOnlineGift,
  deleteAllMail,
  deleteMail,
  drawGrowth,
  signIn,
} from './handlers-d'
import {
  abandonSession,
  rewardDiudiuleSession,
  rewardGameSession,
  startDiudiuleSession,
  startGameSession,
} from './sessions'
import { advanceMinute as advanceMinuteBatch, advanceRuntimeMinutes } from './tick'

/** Commands implemented by the C3 groups A-D plus actor-bound session slice. */
export const C3_COMMAND_TYPES = [
  'pet.adopt', 'pet.reset', 'pet.bury', 'pet.rename', 'pet.setPaused', 'pet.pokeFace', 'pet.cheer',
  'inventory.buy', 'inventory.use', 'medical.treat',
  'vip.buyPinkDiamond', 'vip.clearPinkDiamond', 'vip.buySweetheart', 'vip.setSweetheart',
  'travel.completeCollection',
  'job.startWork', 'job.startStudy', 'job.startTravel', 'activity.stop', 'task.claim',
  'exam.start', 'exam.submit',
  'signin.sign', 'signin.drawGrowth', 'signin.claimOnlineGift', 'signin.claimBirthdayGift',
  'mail.claim', 'mail.claimAll', 'mail.delete', 'mail.deleteAll',
  'game.startSession', 'game.reward', 'diudiule.startSession', 'diudiule.reward',
  'game.abandonSession', 'island.startQuiz', 'island.answerQuiz',
] as const satisfies readonly CommandKey[]

function toOutcome(state: EngineState, events: DomainEvent[], result: JsonValue | undefined, nowMs: number): RuntimeOutcome {
  recomputePetComputed(state.save)
  state.save.nowTimeLine = Math.floor(nowMs / 1000)
  assertEngineState(state)
  return { ok: true, state, events, ...(result === undefined ? {} : { result }) }
}

function executeHandler(
  state: EngineState,
  ctx: RuntimeCommandContext,
  handler: (context: HandlerContext) => HandlerResult,
): RuntimeOutcome {
  const candidate = cloneEngine(state)
  const rng = createRuntimeRng(candidate.rng)
  const handlerResult = handler({ state: candidate, ctx, rng })
  candidate.rng = rng.state
  return toOutcome(candidate, handlerResult.events, handlerResult.result, ctx.gameTimeMs)
}

function unsupportedCommand(commandType: string): never {
  reject('not_available', 'command is outside the C3 runtime slice: ' + commandType)
}

export function executeCommand(
  state: EngineState,
  command: PetCommand,
  ctx: RuntimeCommandContext,
): RuntimeOutcome {
  if (isCommandKey(command.type) === false || validateCommandPayload(command.type, command.payload) === false) {
    return {
      ok: false,
      events: [],
      error: { code: 'invalid_payload', message: 'invalid payload for ' + command.type, refreshProjection: false },
    }
  }
  if (commandRole(command.type) === 'owner' && ctx.actorRole !== 'owner') {
    return {
      ok: false,
      events: [],
      error: { code: 'unauthorized', message: 'owner authority is required', refreshProjection: false },
    }
  }
  try {
    switch (command.type as CommandKey) {
      case 'pet.adopt': return executeHandler(state, ctx, context => adoptPet(context, command.payload as never))
      case 'pet.reset': return executeHandler(state, ctx, context => resetPet(context))
      case 'pet.bury': return executeHandler(state, ctx, context => buryPet(context))
      case 'pet.rename': return executeHandler(state, ctx, context => renamePet(context, command.payload as never))
      case 'pet.setPaused': return executeHandler(state, ctx, context => setPetPaused(context, command.payload as never))
      case 'pet.pokeFace': return executeHandler(state, ctx, context => pokeFace(context, command.payload as never))
      case 'pet.cheer': return executeHandler(state, ctx, context => cheerPet(context))
      case 'inventory.buy': return executeHandler(state, ctx, context => buyInventoryItem(context, command.payload as never))
      case 'inventory.use': return executeHandler(state, ctx, context => useInventoryItem(context, command.payload as never))
      case 'medical.treat': return executeHandler(state, ctx, context => medicalTreat(context, command.payload as never))
      case 'vip.buyPinkDiamond': return executeHandler(state, ctx, context => buyPinkDiamond(context, command.payload as never))
      case 'vip.clearPinkDiamond': return executeHandler(state, ctx, context => clearPinkDiamond(context))
      case 'vip.buySweetheart': return executeHandler(state, ctx, context => buySweetheart(context, command.payload as never))
      case 'vip.setSweetheart': return executeHandler(state, ctx, context => setSweetheart(context, command.payload as never))
      case 'travel.completeCollection': return executeHandler(state, ctx, context => completeTravelCollection(context))
      case 'job.startWork': return executeHandler(state, ctx, context => startWork(context, command.payload as never))
      case 'job.startStudy': return executeHandler(state, ctx, context => startStudy(context, command.payload as never))
      case 'job.startTravel': return executeHandler(state, ctx, context => startTravel(context))
      case 'activity.stop': return executeHandler(state, ctx, context => stopActivity(context))
      case 'task.claim': return executeHandler(state, ctx, context => claimTaskReward(context, command.payload as never))
      case 'exam.start': return executeHandler(state, ctx, context => examStart(context, command.payload as never))
      case 'exam.submit': return executeHandler(state, ctx, context => examSubmit(context, command.payload as never))
      case 'signin.sign': return executeHandler(state, ctx, context => signIn(context))
      case 'signin.drawGrowth': return executeHandler(state, ctx, context => drawGrowth(context))
      case 'signin.claimOnlineGift': return executeHandler(state, ctx, context => claimOnlineGift(context))
      case 'signin.claimBirthdayGift': return executeHandler(state, ctx, context => claimBirthdayGift(context))
      case 'mail.claim': return executeHandler(state, ctx, context => claimMail(context, command.payload as never))
      case 'mail.claimAll': return executeHandler(state, ctx, context => claimAllMail(context))
      case 'mail.delete': return executeHandler(state, ctx, context => deleteMail(context, command.payload as never))
      case 'mail.deleteAll': return executeHandler(state, ctx, context => deleteAllMail(context, command.payload as never))
      case 'game.startSession': return executeHandler(state, ctx, context => startGameSession(context.state, command.payload as never, context.ctx, context.rng))
      case 'game.reward': return executeHandler(state, ctx, context => rewardGameSession(context.state, command.payload as never, context.ctx))
      case 'diudiule.startSession': return executeHandler(state, ctx, context => startDiudiuleSession(context.state, context.ctx, context.rng))
      case 'diudiule.reward': return executeHandler(state, ctx, context => rewardDiudiuleSession(context.state, command.payload as never, context.ctx))
      case 'game.abandonSession': return executeHandler(state, ctx, context => abandonSession(context.state, command.payload as never, context.ctx))
      case 'island.startQuiz': return executeHandler(state, ctx, context => islandQuizStart(context, command.payload as never))
      case 'island.answerQuiz': return executeHandler(state, ctx, context => islandQuizAnswer(context, command.payload as never))
      default:
        return unsupportedCommand(command.type)
    }
  } catch (error) {
    if (error instanceof RuntimeFailure) return { ok: false, events: [], error: error.error }
    return {
      ok: false,
      events: [],
      error: {
        code: 'internal',
        message: error instanceof Error ? error.message : 'internal runtime error',
        refreshProjection: false,
      },
    }
  }
}

function validateAdvance(state: EngineState): void {
  if (Number.isSafeInteger(state.gameTimeMs) === false) reject('invalid_payload', 'gameTimeMs must be a safe integer')
  if (Number.isSafeInteger(state.nextDailyBoundaryMs) === false) reject('invalid_payload', 'nextDailyBoundaryMs must be a safe integer')
}

export function advanceMinute(state: EngineState, ctx: RuntimeContext): RuntimeOutcome {
  try {
    validateAdvance(state)
    const batch = advanceMinuteBatch(state, ctx)
    return toOutcome(batch.state, batch.events, undefined, batch.state.gameTimeMs)
  } catch (error) {
    if (error instanceof RuntimeFailure) return { ok: false, events: [], error: error.error }
    return {
      ok: false,
      events: [],
      error: { code: 'internal', message: error instanceof Error ? error.message : 'internal tick error', refreshProjection: false },
    }
  }
}

export function advanceMinutes(
  state: EngineState,
  ctx: RuntimeContext,
  minutes: number,
  maxBatchMinutes = 1440,
): RuntimeOutcome {
  try {
    validateAdvance(state)
    const batch = advanceRuntimeMinutes(state, ctx, minutes, maxBatchMinutes)
    return toOutcome(batch.state, batch.events, { ticks: batch.ticks }, batch.state.gameTimeMs)
  } catch (error) {
    if (error instanceof RuntimeFailure) return { ok: false, events: [], error: error.error }
    return {
      ok: false,
      events: [],
      error: { code: 'internal', message: error instanceof Error ? error.message : 'internal tick error', refreshProjection: false },
    }
  }
}

export interface HeadlessRuntime {
  snapshot(): EngineState
  execute(command: PetCommand, ctx: RuntimeCommandContext): RuntimeOutcome
  tick(ctx: RuntimeContext): RuntimeOutcome
  advance(ctx: RuntimeContext, minutes: number): RuntimeOutcome
}

/** Stateful convenience wrapper used by headless hosts/tests; the pure functions remain authoritative. */
export function createHeadlessRuntime(initialState: EngineState, options: HeadlessRuntimeOptions = {}): HeadlessRuntime {
  assertEngineState(initialState)
  let state = cloneEngine(initialState)
  return {
    snapshot(): EngineState {
      return cloneEngine(state)
    },
    execute(command: PetCommand, ctx: RuntimeCommandContext): RuntimeOutcome {
      const outcome = executeCommand(state, command, ctx)
      if (outcome.ok) state = outcome.state
      return outcome
    },
    tick(ctx: RuntimeContext): RuntimeOutcome {
      const outcome = advanceMinute(state, ctx)
      if (outcome.ok) state = outcome.state
      return outcome
    },
    advance(ctx: RuntimeContext, minutes: number): RuntimeOutcome {
      const outcome = advanceMinutes(state, ctx, minutes, options.maxBatchMinutes)
      if (outcome.ok) state = outcome.state
      return outcome
    },
  }
}

export const applyCommand = executeCommand
export const advanceRuntime = advanceMinutes

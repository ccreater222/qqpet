import { fallbackWeatherForDay } from '../../src/shared/pet-runtime/environment.ts'
import { createRngState } from '../../src/shared/pet-runtime/rng.ts'
import { RUNTIME_SCHEMA_VERSION } from '../../src/shared/pet-runtime/types.ts'
import { startSave } from '../../src/shared/save-logic.ts'
import {
  LOCAL_DOCUMENT_FORMAT,
  LOCAL_DOCUMENT_SCHEMA_VERSION,
  PORTABLE_BUNDLE_FORMAT,
  PORTABLE_BUNDLE_SCHEMA_VERSION,
  REMOTE_PROJECTION_CACHE_FORMAT,
  REMOTE_PROJECTION_CACHE_SCHEMA_VERSION,
  toDeviceLocalOverlay,
  toSharedSaveData,
} from '../../src/shared/sync/index.ts'

export const SEED = '000102030405060708090a0b0c0d0e0f'
export const LOCAL_DEVICE_ID = 'local-device-0001'
export const GAME_TIME_MS = Date.UTC(2026, 9, 20, 8, 0, 0)
export const WALL_TIME_MS = GAME_TIME_MS
export const DAY_KEY = '2026-10-20'
export const NEXT_BOUNDARY_MS = Date.UTC(2026, 9, 20, 22, 0, 0)

export function createSyncFixtures() {
  const save = startSave(null)
  save.havePet = true
  save.petInfo.name = '企鹅'
  save.petInfo.host = '主人'
  save.petInfo.intel = 10
  save.petInfo.charm = 11
  save.petInfo.strong = 12
  save.saveJsonData = {
    ...save.saveJsonData,
    farm: '{}',
    activity: '{}',
    island: '{}',
    community: '{"x":12,"y":34}',
    weather: '2026-10-20',
  }
  save.settings.aiKey = 'sk-test-secret'
  save.settings.searchKey = 'search-test-secret'
  save.settings.webhookToken = 'webhook-test-secret'
  const shared = toSharedSaveData(save)
  const device = toDeviceLocalOverlay(save, LOCAL_DEVICE_ID, { community: { x: 12, y: 34 } })
  const weather = fallbackWeatherForDay(SEED, DAY_KEY, { fetchedAtMs: GAME_TIME_MS })
  const examSession = {
    sessionToken: 'exam-token-0001',
    actorDeviceId: LOCAL_DEVICE_ID,
    payload: {
      kind: 'exam',
      subject: '数学',
      questions: [
        { questionId: 'q-1', prompt: '1 + 1 = ?', options: ['1', '2', '3'], answerIndex: 1 },
        { questionId: 'q-2', prompt: '2 + 2 = ?', options: ['3', '4', '5'], answerIndex: 1 },
      ],
      examMetadata: { lesson: 3, school: '企鹅小学' },
    },
    startedAtGameMs: GAME_TIME_MS,
    expiresAtGameMs: GAME_TIME_MS + 30 * 60_000,
    status: 'active',
  }
  const quizSession = {
    sessionToken: 'quiz-token-0001',
    actorDeviceId: LOCAL_DEVICE_ID,
    payload: {
      kind: 'island_quiz',
      quizKind: 'riddle',
      recordId: 'record-0001',
      prompt: '谁的尾巴长？',
      options: ['企鹅', '兔子', '大象'],
      answerIndex: 2,
      metadata: { npcId: 'npc-0001' },
    },
    startedAtGameMs: GAME_TIME_MS,
    expiresAtGameMs: GAME_TIME_MS + 10 * 60_000,
    status: 'active',
  }
  const gameSession = {
    sessionToken: 'game-token-0001',
    actorDeviceId: LOCAL_DEVICE_ID,
    payload: {
      kind: 'game',
      gameId: 'smallgame-0001',
      gameKind: 'small',
      presentationSeed: 'presentation-seed-0001',
    },
    startedAtGameMs: GAME_TIME_MS,
    expiresAtGameMs: GAME_TIME_MS + 60 * 60_000,
    status: 'active',
  }
  const engine = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    save: shared,
    gameTimeMs: GAME_TIME_MS,
    lastSchedulerWallMs: WALL_TIME_MS,
    timeZone: 'Asia/Shanghai',
    weatherLocation: 'Shanghai',
    advanceWhileEmpty: true,
    rng: createRngState(SEED),
    scheduledJobs: [{ id: 1, type: 'work', dueAtGameMs: GAME_TIME_MS + 60_000, payload: { jobId: 'work-1' }, status: 'pending' }],
    nextScheduledJobId: 2,
    gameSessions: [gameSession, examSession, quizSession],
    sessionCoverage: [{
      coverageId: 'coverage-0001',
      deviceId: LOCAL_DEVICE_ID,
      connectedAtWallMs: WALL_TIME_MS - 60_000,
      lastHeartbeatWallMs: WALL_TIME_MS,
    }],
    coverageReopen: {
      operationId: 'reopen-0001',
      commitWallMs: WALL_TIME_MS,
      survivors: [{
        kind: 'local_app',
        appInstanceId: 'app-instance-0001',
        localDeviceId: LOCAL_DEVICE_ID,
        lastHeartbeatWallMs: WALL_TIME_MS,
        eligible: true,
      }],
      state: 'pending',
    },
    lastProcessedDayBoundaryKey: DAY_KEY,
    nextDailyBoundaryMs: NEXT_BOUNDARY_MS,
    importClamped: false,
    clockSkippedMs: 0,
    environment: {
      calendarByDay: {},
      weatherByDay: { [DAY_KEY]: weather },
    },
  }
  const authority = {
    owner: 'local',
    authorityId: 'authority-local-0001',
    epoch: 1,
    restoreGeneration: 1,
    revision: 3,
    eventSeq: 4,
    handoffId: 'handoff-0001',
    detachedAtWallMs: WALL_TIME_MS,
  }
  const bundle = {
    format: PORTABLE_BUNDLE_FORMAT,
    schemaVersion: PORTABLE_BUNDLE_SCHEMA_VERSION,
    exportedAtWallMs: WALL_TIME_MS,
    authority,
    originLocalDeviceId: LOCAL_DEVICE_ID,
    shared,
    engine,
  }
  const localDocument = {
    format: LOCAL_DOCUMENT_FORMAT,
    schemaVersion: LOCAL_DOCUMENT_SCHEMA_VERSION,
    revision: authority.revision,
    eventSeq: authority.eventSeq,
    authority: { state: 'active', stamp: authority },
    bundle,
    runtime: { appInstanceId: 'app-instance-0001', startedAtWallMs: WALL_TIME_MS },
    device,
  }
  const remoteCache = {
    format: REMOTE_PROJECTION_CACHE_FORMAT,
    schemaVersion: REMOTE_PROJECTION_CACHE_SCHEMA_VERSION,
    petId: 'pet-0001',
    deviceId: 'server-device-0001',
    revision: 3,
    eventSeq: 4,
    gameTimeMs: GAME_TIME_MS,
    timeZone: 'Asia/Shanghai',
    advanceWhileEmpty: true,
    authority: {
      owner: 'server',
      authorityId: 'authority-server-0001',
      restoreGeneration: 1,
      epoch: 2,
      state: 'active',
    },
    shared,
    device,
  }
  return { save, shared, device, engine, authority, bundle, localDocument, remoteCache, gameSession, examSession, quizSession }
}

// 证据：导入存档里 island/farm/fishs 为空或缺失时，相关命令自身会把 canonical 结构补齐（与 task 静态表不同）。
// 运行：node --experimental-strip-types audit/similar-errors/evidence/self-initializing-blobs.mjs
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL && /\/src\/shared\//.test(context.parentURL) &&
        /\.[cm]?[jt]s$/.test(specifier) === false && specifier.endsWith('.json') === false) return nextResolve(specifier + '.ts', context)
    return nextResolve(specifier, context)
  },
})

const ROOT = new URL('../../..', import.meta.url)
const importTs = path => import(new URL(path, ROOT).href)
const clone = value => JSON.parse(JSON.stringify(value))

const { createHeadlessRuntime, createRngState, dayKeyAt } = await importTs('src/shared/pet-runtime/index.ts')
const { createSyncFixtures, SEED, GAME_TIME_MS, DAY_KEY, NEXT_BOUNDARY_MS } = await importTs('scripts/tests/sync-fixtures.mjs')
const fixture = JSON.parse(readFileSync(new URL('./../fixtures/imported-shared.json', import.meta.url), 'utf8'))
const fixtures = createSyncFixtures()

function engineWith(save) {
  const state = clone(fixtures.engine)
  state.save = save
  Object.assign(state.save.petInfo, { growth: 5000, health: 5, hunger: 1100, clean: 1100, mood: 1000, yb: 50000 })
  state.gameTimeMs = GAME_TIME_MS
  state.lastSchedulerWallMs = GAME_TIME_MS
  state.timeZone = 'Asia/Shanghai'
  state.rng = createRngState(SEED)
  state.lastProcessedDayBoundaryKey = DAY_KEY
  state.nextDailyBoundaryMs = NEXT_BOUNDARY_MS
  return state
}

const context = state => ({
  gameTimeMs: state.gameTimeMs,
  environment: state.environment,
  activeClientCount: 1,
  sessionActive: true,
  actorDeviceId: 'audit-device',
  actorRole: 'owner',
})

const scenarios = [
  ['island.arriveScene', { sceneId: '3' }, 'island', blob => ({ day: blob.day, errands: blob.errands?.length ?? 0, want: blob.want })],
  ['farm.reclaim', { plotIds: [6] }, 'farm', blob => ({ rank: blob.rank, farmland: blob.farmland?.length ?? 0 })],
  ['fishing.buy', { fryId: 2, quantity: 1 }, 'fishs', blob => ({ fishs: blob.fishs?.length ?? 0 })],
  ['island.refreshNews', { dayKey: dayKeyAt(GAME_TIME_MS, 'Asia/Shanghai') }, 'island', blob => ({ newsFacts: blob.newsFacts?.length ?? 0 })],
]

for (const [type, payload, blobKey, summarize] of scenarios) {
  const save = clone(fixture)
  save.saveJsonData[blobKey] = '{}'
  const runtime = createHeadlessRuntime(engineWith(save))
  const outcome = runtime.execute({ type, payload }, context(runtime.snapshot()))
  const after = runtime.snapshot().save.saveJsonData[blobKey]
  const parsed = JSON.parse(after)
  console.log(type, '->', outcome.ok ? 'ok' : outcome.error.code + ': ' + outcome.error.message, '|', blobKey, '=', JSON.stringify(summarize(parsed)))
}

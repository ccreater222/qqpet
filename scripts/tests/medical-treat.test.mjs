import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL &&
        /\/src\/shared\/(pet-runtime|sync)\//.test(context.parentURL) &&
        /\.[cm]?[jt]s$/.test(specifier) === false && specifier.endsWith('.json') === false) {
      return nextResolve(specifier + '.ts', context)
    }
    return nextResolve(specifier, context)
  },
})

const { createHeadlessRuntime, executeCommand } = await import('../../src/shared/pet-runtime/index.ts')
const { medicalQuote } = await import('../../src/shared/pet-runtime/medical-cost.ts')
const { ILLS } = await import('../../src/shared/pet-runtime/content/ills.ts')
const { LOCAL_DEVICE_ID, createSyncFixtures } = await import('./sync-fixtures.mjs')

const fixtures = createSyncFixtures()

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function stateWith({ health, ill = '0-', medicines = [], yb = 30_000 }) {
  const state = clone(fixtures.engine)
  state.save.petInfo.health = health
  state.save.activeOption.ill = ill
  state.save.selfGoodDatas.medicine = medicines.slice()
  state.save.petInfo.yb = yb
  return state
}

function contextFor(state) {
  return {
    gameTimeMs: state.gameTimeMs,
    environment: state.environment,
    activeClientCount: 1,
    sessionActive: true,
    actorDeviceId: LOCAL_DEVICE_ID,
  }
}

function treatDoctor(state) {
  const runtime = createHeadlessRuntime(state)
  return runtime.execute({ type: 'medical.treat', payload: { mode: 'doctor' } }, contextFor(state))
}

const CASES = [
  { name: 'health 4 without the cure', health: 4, ill: '0-', medicines: [], total: 70, medicineId: '10003' },
  { name: 'health 4 with the cure in the bag', health: 4, ill: '0-', medicines: ['_10003*2'], total: 10, medicineId: '10003' },
  { name: 'health 1 without the cure', health: 1, ill: '1-', medicines: [], total: 280, medicineId: '30001' },
  { name: 'health 1 with the cure in the bag', health: 1, ill: '1-', medicines: ['_30001*1'], total: 40, medicineId: '30001' },
  { name: 'dead without the revive medicine', health: 0, ill: '0-', medicines: [], total: 10_560, medicineId: '60001' },
  { name: 'dead with the revive medicine in the bag', health: 0, ill: '0-', medicines: ['_60001*2'], total: 0, medicineId: '60001' },
]

for (const item of CASES) {
  test('medical.treat doctor charges exactly the shared quote: ' + item.name, () => {
    const state = stateWith(item)
    const quote = medicalQuote(state.save)
    assert.notEqual(quote, null)
    assert.equal(quote.total, item.total, 'quote total')
    assert.equal(quote.medicineId, item.medicineId)

    const outcome = treatDoctor(state)
    assert.equal(outcome.ok, true, JSON.stringify(outcome.ok ? outcome.result : outcome.error))
    const charged = state.save.petInfo.yb - outcome.state.save.petInfo.yb
    assert.equal(charged, quote.total, 'authoritative yb charge must equal the quote total')
    assert.equal(outcome.state.save.petInfo.health, 5)
    assert.equal(outcome.state.save.activeOption.ill, null)

    if (quote.ownsMedicine) {
      const [id, count] = item.medicines[0].slice(1).split('*')
      const left = Number(count) - 1
      assert.deepEqual(
        outcome.state.save.selfGoodDatas.medicine,
        left > 0 ? ['_' + id + '*' + left] : [],
        'one owned cure is taken from the bag',
      )
    } else {
      assert.deepEqual(outcome.state.save.selfGoodDatas.medicine, [], 'the doctor does not grant the medicine to the bag')
    }
  })
}

test('medical.treat rejects a healthy pet with not_available and charges nothing', () => {
  const state = stateWith({ health: 5, ill: '0-', medicines: [] })
  assert.equal(medicalQuote(state.save), null)
  const outcome = executeCommand(state, { type: 'medical.treat', payload: { mode: 'doctor' } }, contextFor(state))
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'not_available')
})

test('medical.treat maps an unavailable medicine to not_available, like the quote lookup', () => {
  ILLS.push({
    type: 'ill',
    name: '缺药症',
    health: 4,
    cure: { icon: '_99999', id: '99999', name: '不存在的药' },
    tolk: '',
    errTolk: '',
    successTolk: '',
    router: '3-4',
  })
  try {
    const state = stateWith({ health: 4, ill: '3-', medicines: [] })
    assert.throws(() => medicalQuote(state.save), /unknown good: medicine\/99999/)
    const outcome = executeCommand(state, { type: 'medical.treat', payload: { mode: 'doctor' } }, contextFor(state))
    assert.equal(outcome.ok, false)
    assert.equal(outcome.error.code, 'not_available')
    assert.equal(state.save.petInfo.yb, 30_000, 'an unavailable medicine must not charge the owner')
  } finally {
    ILLS.pop()
  }
})

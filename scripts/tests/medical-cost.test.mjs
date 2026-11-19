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

const { cureForHealth, medicalQuote } = await import('../../src/shared/pet-runtime/medical-cost.ts')
const { DEAD, ILLS } = await import('../../src/shared/pet-runtime/content/ills.ts')

/** Minimal canonical save view: the quote only reads health, the ill line and medicines. */
function saveWith({ health, ill = '0-', medicines = [] }) {
  return {
    petInfo: { health },
    activeOption: { ill },
    selfGoodDatas: { medicine: medicines.slice() },
  }
}

test('medical: a healthy pet has no quote', () => {
  assert.equal(medicalQuote(saveWith({ health: 5, ill: '0-', medicines: ['_10003*1'] })), null)
  assert.equal(medicalQuote(saveWith({ health: 5, ill: null, medicines: [] })), null)
})

test('medical: health 4 without the cure bills the visit plus the medicine with a 20% markup', () => {
  const quote = medicalQuote(saveWith({ health: 4, ill: '0-' }))
  assert.notEqual(quote, null)
  assert.equal(quote.health, 4)
  assert.equal(quote.dead, false)
  assert.equal(quote.fee, 10)
  assert.equal(quote.medicineId, '10003')
  assert.equal(quote.medicineName, '枇杷糖浆')
  assert.equal(quote.medicinePrice, 50)
  assert.equal(quote.ownsMedicine, false)
  assert.equal(quote.medicineCharge, 60)
  assert.equal(quote.total, 70)
  assert.equal(quote.total, quote.fee + quote.medicineCharge)
})

test('medical: health 4 with the cure in the bag bills only the visit', () => {
  const quote = medicalQuote(saveWith({ health: 4, ill: '0-', medicines: ['_10003*2'] }))
  assert.notEqual(quote, null)
  assert.equal(quote.ownsMedicine, true)
  assert.equal(quote.medicineCharge, 0)
  assert.equal(quote.fee, 10)
  assert.equal(quote.total, 10)
})

test('medical: deeper illness quotes the matching cure and a larger fee', () => {
  const quote = medicalQuote(saveWith({ health: 1, ill: '1-' }))
  assert.notEqual(quote, null)
  assert.equal(quote.medicineId, '30001')
  assert.equal(quote.medicinePrice, 200)
  assert.equal(quote.fee, 40)
  assert.equal(quote.medicineCharge, 240)
  assert.equal(quote.total, 280)
})

test('medical: death has no visit fee but still bills the revive medicine', () => {
  const quote = medicalQuote(saveWith({ health: 0, ill: '0-' }))
  assert.notEqual(quote, null)
  assert.equal(quote.dead, true)
  assert.equal(quote.health, 0)
  assert.equal(quote.fee, 0)
  assert.equal(quote.medicineId, DEAD.cure.id)
  assert.equal(quote.medicineName, '还魂丹')
  assert.equal(quote.medicinePrice, 8800)
  assert.equal(quote.ownsMedicine, false)
  assert.equal(quote.medicineCharge, 10560)
  assert.equal(quote.total, 10560)
})

test('medical: death with the revive medicine in the bag is free', () => {
  const quote = medicalQuote(saveWith({ health: 0, ill: '0-', medicines: ['_60001*2'] }))
  assert.notEqual(quote, null)
  assert.equal(quote.dead, true)
  assert.equal(quote.ownsMedicine, true)
  assert.equal(quote.medicineCharge, 0)
  assert.equal(quote.total, 0)
})

test('medical: cureForHealth keeps the handler mapping for illness and death', () => {
  assert.equal(cureForHealth(saveWith({ health: 0, ill: '2-' })), DEAD)
  assert.equal(cureForHealth(saveWith({ health: 4, ill: '0-' })).cure.id, '10003')
  assert.equal(cureForHealth(saveWith({ health: 2, ill: '1-' })).cure.id, '20001')
  // A missing ill line falls back to the first line, exactly like the handler did.
  assert.equal(cureForHealth(saveWith({ health: 3, ill: null })).cure.id, '30004')
})

test('medical: an unknown cure is rejected by the same content lookup the handler uses', () => {
  // Every shipped cure exists, so the defensive branch is exercised by extending
  // the content table for the duration of this test; the handler shares that table.
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
    assert.throws(() => medicalQuote(saveWith({ health: 4, ill: '3-' })), /unknown good: medicine\/99999/)
  } finally {
    ILLS.pop()
  }
})

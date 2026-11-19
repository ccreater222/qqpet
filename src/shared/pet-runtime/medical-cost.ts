import type { SharedSaveData } from '../sync/data-boundary'
import { DEAD, illOf, type Ill } from './content/ills'
import { goodOf } from './content/index'

/** Doctor visit price per missing health point, as charged by the authoritative handler. */
const VISIT_PRICE_PER_POINT = 10

/**
 * Reads one canonical `_<id>*<count>` inventory entry. The quote only needs the
 * medicine list, so it decodes it locally instead of widening its save view to
 * the whole document; `runtime-helpers.inventoryCount` owns the write side.
 */
function medicineCount(save: Pick<SharedSaveData, 'selfGoodDatas'>, id: string): number {
  const entry = save.selfGoodDatas.medicine.find((line) => line.startsWith('_' + id + '*'))
  if (entry === undefined) return 0
  return Number(entry.split('*')[1] ?? 0) || 0
}

/** The cure a doctor would use, from death or from the stored illness line and current health. */
export function cureForHealth(save: Pick<SharedSaveData, 'petInfo' | 'activeOption'>): Ill {
  if (save.petInfo.health === 0) return DEAD
  const line = typeof save.activeOption.ill === 'string' ? save.activeOption.ill : '1-'
  return illOf(line + save.petInfo.health)
}

/** Everything the doctor will charge for one treatment; the renderer quotes it, the handler bills it. */
export interface MedicalQuote {
  health: number
  dead: boolean
  /** Consultation fee; death has none. */
  fee: number
  medicineId: string
  medicineName: string
  /** Unit price from the canonical goods table; 50 when a cure ships without a price. */
  medicinePrice: number
  ownsMedicine: boolean
  /** What buying the cure on the spot costs (price + 20%); 0 when it is already owned. */
  medicineCharge: number
  total: number
}

/**
 * Authoritative doctor quote. Returns null when the pet is healthy (nothing to
 * treat). An unknown cure is not a quote: the content lookup throws exactly like
 * it does for the handler, which maps that to `not_available`.
 */
export function medicalQuote(
  save: Pick<SharedSaveData, 'petInfo' | 'activeOption' | 'selfGoodDatas'>,
): MedicalQuote | null {
  const health = save.petInfo.health
  if (health === 5) return null
  const cure = cureForHealth(save)
  const medicine = goodOf('medicine', cure.cure.id)
  const fee = health > 0 ? (5 - health) * VISIT_PRICE_PER_POINT : 0
  const medicinePrice = medicine.price === undefined ? 50 : medicine.price
  const ownsMedicine = medicineCount(save, medicine.id) > 0
  const medicineCharge = ownsMedicine ? 0 : Math.round(medicinePrice * 1.2)
  return {
    health,
    dead: health === 0,
    fee,
    medicineId: medicine.id,
    medicineName: medicine.name,
    medicinePrice,
    ownsMedicine,
    medicineCharge,
    total: fee + medicineCharge,
  }
}

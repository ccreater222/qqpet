import type { SharedSaveData } from '../sync/data-boundary'
import { goodOf, type GoodType, type RuntimeGood } from './content/index'
import { domainEvent, type DomainEvent } from './events'
import {
  addTaskCount,
  applyGood,
  startTimedGood,
  takeGood,
} from './runtime-helpers'

export const SWEETHEART_NEEDS = [
  { stat: 'hunger', type: 'food', task: 'Eat' },
  { stat: 'clean', type: 'clean', task: 'Clean' },
  { stat: 'mood', type: 'toy', task: 'Toy' },
] as const

function inventoryGoods(save: SharedSaveData, type: GoodType): RuntimeGood[] {
  const goods: RuntimeGood[] = []
  for (const entry of save.selfGoodDatas[type]) {
    const [id, count] = entry.slice(1).split('*')
    try {
      goods.push(goodOf(type, id, Number(count ?? 1)))
    } catch {
      continue
    }
  }
  return goods
}

function pickCare(goods: readonly RuntimeGood[], stat: 'hunger' | 'clean' | 'mood', deficit: number): RuntimeGood | null {
  let fit: RuntimeGood | null = null
  let over: RuntimeGood | null = null
  for (const good of goods) {
    const value = good[stat] ?? 0
    if (value <= 0) continue
    if (value <= deficit) {
      if (fit === null || value > (fit[stat] ?? 0)) fit = good
    } else if (over === null || value < (over[stat] ?? 0)) over = good
  }
  return fit ?? over
}

/** One canonical sweetheart self-care action, matching renderer selfCare(). */
export function selfCare(state: { save: SharedSaveData }): DomainEvent[] {
  const save = state.save
  if (save.petInfo.sweetHeart !== true) return []
  for (const need of SWEETHEART_NEEDS) {
    const stat = need.stat
    const max = save.petComputedlInfo[stat === 'hunger' ? 'hungerMax' : stat === 'clean' ? 'cleanMax' : 'moodMax']
    if (save.petInfo[stat] / max >= 0.6) continue
    const good = pickCare(inventoryGoods(save, need.type), stat, max - save.petInfo[stat])
    if (good === null) continue
    if (takeGood(save, need.type, good.id, 1) === false) continue
    applyGood(save, good, need.type === 'food' || need.type === 'clean' ? 20 : 0)
    if (good.useTimeing) startTimedGood(save, good, good.useTimeing)
    const task = addTaskCount(save, need.task, 1)
    return [
      domainEvent('item.consumed', { itemId: good.id, type: need.type, source: 'sweetheart' }),
      domainEvent('pet.statsChanged', {
        hunger: save.petInfo.hunger, clean: save.petInfo.clean, mood: save.petInfo.mood,
      }),
      domainEvent('task.progress', { counter: need.task, amount: 1, total: task.doNums[need.task] ?? 0 }),
    ]
  }
  return []
}

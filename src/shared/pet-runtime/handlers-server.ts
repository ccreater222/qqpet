import type { CommandPayloadMap } from '../sync/protocol'
import { allGoods, type GoodType } from './content/index'
import { domainEvent, type DomainEvent } from './events'
import type { HandlerContext, HandlerResult } from './handler-types'
import { addGood, reject, recomputePetComputed } from './runtime-helpers'
import { dayKeyAt, reconcileTimeZone } from './time'
import type { JsonObject, JsonValue } from './types'

const MAX_ADMIN_RANDOM_GOODS = 1000
const MAX_ADMIN_CHEAT_AMOUNT = 1_000_000

function json<T>(value: T): JsonValue {
  return value as unknown as JsonValue
}

function event(type: string, payload: JsonObject): DomainEvent {
  return domainEvent(type, payload)
}

export function settingsSetShared(context: HandlerContext, payload: CommandPayloadMap['settings.setShared']): HandlerResult {
  if (payload.key === 'difficulty') {
    if (payload.value !== 'easy' && payload.value !== 'standard') reject('invalid_payload', 'invalid difficulty value')
    context.state.save.settings.difficulty = payload.value
  } else {
    if (typeof payload.value !== 'boolean') reject('invalid_payload', 'invalid undying value')
    context.state.save.settings.undying = payload.value
  }
  return {
    result: json({ key: payload.key, value: payload.value }),
    events: [event('settings.changed', { key: payload.key, value: payload.value })],
  }
}

export function serverSetAdvanceWhileEmpty(context: HandlerContext, payload: CommandPayloadMap['server.setAdvanceWhileEmpty']): HandlerResult {
  context.state.advanceWhileEmpty = payload.enabled
  return {
    result: json({ advanceWhileEmpty: payload.enabled }),
    events: [event('server.changed', { key: 'advanceWhileEmpty', value: payload.enabled })],
  }
}

export function serverSetTimeZone(context: HandlerContext, payload: CommandPayloadMap['server.setTimeZone']): HandlerResult {
  const previous = context.state.timeZone
  const reconciled = reconcileTimeZone(context.state.gameTimeMs, payload.timeZone)
  context.state.timeZone = payload.timeZone
  context.state.lastProcessedDayBoundaryKey = reconciled.lastProcessedDayBoundaryKey
  context.state.nextDailyBoundaryMs = reconciled.nextDailyBoundaryMs
  return {
    result: json({
      previousTimeZone: previous,
      timeZone: payload.timeZone,
      nextDailyBoundaryMs: reconciled.nextDailyBoundaryMs,
    }),
    events: [event('server.changed', { key: 'timeZone', value: payload.timeZone, nextDailyBoundaryMs: reconciled.nextDailyBoundaryMs })],
  }
}

export function serverSetWeatherCity(context: HandlerContext, payload: CommandPayloadMap['server.setWeatherCity']): HandlerResult {
  const previous = context.state.weatherLocation
  const currentDay = dayKeyAt(context.state.gameTimeMs, context.state.timeZone)
  const weatherByDay = Object.fromEntries(
    Object.entries(context.state.environment.weatherByDay).filter(([dayKey]) => dayKey < currentDay),
  )
  context.state.weatherLocation = payload.city
  context.state.environment = { ...context.state.environment, weatherByDay }
  return {
    result: json({ previousWeatherCity: previous, weatherCity: payload.city, invalidatedFromDayKey: currentDay }),
    events: [event('server.changed', { key: 'weatherCity', value: payload.city, invalidatedFromDayKey: currentDay })],
  }
}

export function adminGrantCheat(context: HandlerContext, payload: CommandPayloadMap['admin.grantCheat']): HandlerResult {
  if (Number.isFinite(payload.amount) === false || payload.amount <= 0 || payload.amount > MAX_ADMIN_CHEAT_AMOUNT) {
    reject('invalid_payload', 'cheat amount must be a finite positive amount within the safe maximum')
  }
  const stat = payload.stat
  const next = context.state.save.petInfo[stat] + payload.amount
  if (stat === 'health') {
    context.state.save.petInfo.health = Math.max(0, Math.min(context.state.save.petComputedlInfo.healthMax, next))
  } else if (stat === 'growth') {
    context.state.save.petInfo.growth = Math.max(0, next)
  } else if (stat === 'mood' || stat === 'hunger' || stat === 'clean') {
    const max = stat === 'mood'
      ? context.state.save.petComputedlInfo.moodMax
      : stat === 'hunger'
        ? context.state.save.petComputedlInfo.hungerMax
        : context.state.save.petComputedlInfo.cleanMax
    context.state.save.petInfo[stat] = Math.max(0, Math.min(max, next))
  } else {
    context.state.save.petInfo.yb = Math.max(0, next)
  }
  recomputePetComputed(context.state.save)
  return {
    result: json({ stat, amount: payload.amount, value: context.state.save.petInfo[stat] }),
    events: [event('admin.grant', { kind: 'stat', stat, amount: payload.amount })],
  }
}

export function adminGrantRandomGoods(context: HandlerContext, payload: CommandPayloadMap['admin.grantRandomGoods']): HandlerResult {
  if (payload.quantity > MAX_ADMIN_RANDOM_GOODS) reject('invalid_payload', 'admin random goods quantity exceeds the safe maximum')
  const type = payload.type as GoodType
  const pool = allGoods(type)
  if (pool.length === 0) reject('not_available', 'unknown admin good type')
  const goods = []
  for (let index = 0; index < payload.quantity; index++) {
    const picked = context.rng.pickOne(pool)
    if (picked === null) break
    const good = { ...picked, num: 1 }
    addGood(context.state.save, good, 1)
    goods.push({ id: good.id, type: good.type, name: good.name, num: 1 })
  }
  return {
    result: json({ goods }),
    events: [event('admin.grant', { kind: 'goods', type: payload.type, quantity: goods.length })],
  }
}

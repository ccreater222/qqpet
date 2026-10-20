import type { CommandPayloadMap } from '../sync/protocol'
import { BIRTHDAY_FOOD_IDS, goodOf } from './content/index'
import { domainEvent } from './events'
import {
  currentBoundarySeconds,
  grantGoods,
  localDate,
  lootGoods,
  payYb,
  readMails,
  readSignIn,
  reject,
  requirePet,
  writeMails,
  writeSignIn,
  type LiveMail,
  type MailMap,
} from './runtime-helpers'
import type { HandlerContext, HandlerResult } from './handler-types'
import type { JsonValue } from './types'
import { zonedDateTimeParts } from './time'

function json<T>(value: T): JsonValue {
  return value as unknown as JsonValue
}

function signedTimestamp(context: HandlerContext): { timestamp: number; year: number; month: number; key: string } {
  const timestamp = currentBoundarySeconds(context.ctx.gameTimeMs, context.state.timeZone)
  const date = localDate(timestamp * 1000, context.state.timeZone)
  return { timestamp, year: date.year, month: date.month, key: String(timestamp) }
}

export function signIn(context: HandlerContext): HandlerResult {
  requirePet(context.state)
  const state = readSignIn(context.state.save)
  const today = signedTimestamp(context)
  const months = state.collectionList[String(today.year)] ??= {}
  const days = months[String(today.month)] ??= []
  if (days.includes(today.timestamp)) reject('already_claimed', 'already signed in today')
  days.push(today.timestamp)
  const goods = lootGoods(context.rng, 1).map(good => good.type === 'nums' ? { ...good, num: 20 } : good)
  writeSignIn(context.state.save, state)
  grantGoods(context.state.save, goods)
  return {
    result: json({ day: today.timestamp, goods: goods.map(good => ({ id: good.id, type: good.type, num: good.num })) }),
    events: [
      domainEvent('signin.changed', { signed: true, day: today.timestamp }),
      domainEvent('reward.granted', { source: 'signin', count: goods.length }),
    ],
  }
}

export function drawGrowth(context: HandlerContext): HandlerResult {
  requirePet(context.state)
  const state = readSignIn(context.state.save)
  if (state.getGrowth !== null && (context.state.save.petInfo.pinkDiamond === false || state.getGrowth[1] !== null)) {
    reject('already_claimed', 'the growth draw is not available')
  }
  let first = context.rng.randIntInclusive(0, 5)
  first = context.rng.randIntInclusive(0, first)
  first = context.rng.randIntInclusive(0, first)
  const secondMax = context.rng.randIntInclusive(0, 9)
  const second = context.rng.randIntInclusive(0, secondMax)
  const third = context.rng.randIntInclusive(0, 9)
  const digits = [first, second, third]
  const value = Number(digits.join(''))
  let goods: ReturnType<typeof lootGoods> = []
  if (value > 0) {
    const good = goodOf('nums', 'growth', value)
    goods = [good]
    if (state.getGrowth === null) state.getGrowth = [digits, null]
    else state.getGrowth[1] = digits
    writeSignIn(context.state.save, state)
    grantGoods(context.state.save, goods)
  }
  return {
    result: json({ digits, value, goods: goods.map(good => ({ id: good.id, type: good.type, num: good.num })) }),
    events: [
      domainEvent('signin.changed', { growthDigits: digits, value }),
      ...(goods.length > 0 ? [domainEvent('reward.granted', { source: 'signin-growth', count: goods.length })] : []),
    ],
  }
}

export function claimOnlineGift(context: HandlerContext): HandlerResult {
  requirePet(context.state)
  const state = readSignIn(context.state.save)
  if (state.isOnlineLastTime > 0) reject('cooldown', 'the online gift is not ready')
  const cost = state.onlineGiftNum * 100
  if (cost > 0) payYb(context.state.save, cost)
  const roll = context.rng.randIntInclusive(0, context.state.save.petInfo.pinkDiamond ? 1000 : 10_000)
  const tier = roll < 2 ? 0 : state.onlineGiftNum % 10 === 0 ? 1 : 2
  const count = context.state.save.petInfo.pinkDiamond ? 2 : 1
  const goods = lootGoods(context.rng, count, tier)
  state.onlineGiftNum += 1
  state.isOnlineLastTime = 20
  writeSignIn(context.state.save, state)
  grantGoods(context.state.save, goods)
  return {
    result: json({ cost, goods: goods.map(good => ({ id: good.id, type: good.type, num: good.num })) }),
    events: [
      domainEvent('signin.changed', { onlineGiftNum: state.onlineGiftNum, cost }),
      domainEvent('reward.granted', { source: 'online-gift', count: goods.length }),
    ],
  }
}

export function claimBirthdayGift(context: HandlerContext): HandlerResult {
  requirePet(context.state)
  const state = readSignIn(context.state.save)
  if (state.getBirthDayGift) reject('already_claimed', 'the birthday gift was already claimed today')
  const current = localDate(context.ctx.gameTimeMs, context.state.timeZone)
  const born = zonedDateTimeParts(context.state.save.petInfo.birthDay * 1000, context.state.timeZone)
  if (current.day !== born.day) reject('not_available', 'today is not the birthday')
  const index = context.rng.randIntInclusive(0, BIRTHDAY_FOOD_IDS.length - 1)
  const food = goodOf('food', BIRTHDAY_FOOD_IDS[index])
  state.getBirthDayGift = true
  writeSignIn(context.state.save, state)
  grantGoods(context.state.save, [food])
  return {
    result: json({ itemId: food.id, name: food.name }),
    events: [
      domainEvent('signin.changed', { birthdayGift: true }),
      domainEvent('reward.granted', { source: 'birthday', itemId: food.id }),
    ],
  }
}

function liveMail(mail: MailMap[string] | undefined): LiveMail | null {
  if (mail === undefined || 'e' in mail) return null
  return mail
}

function grantMailGoods(context: HandlerContext, mail: LiveMail): number {
  if (Array.isArray(mail.glb) === false) return 0
  grantGoods(context.state.save, mail.glb)
  return mail.glb.length
}

export function claimMail(context: HandlerContext, payload: CommandPayloadMap['mail.claim']): HandlerResult {
  requirePet(context.state)
  const mails = readMails(context.state.save)
  const mail = liveMail(mails[payload.mailId])
  if (mail === null) reject('not_available', 'mail does not exist or was deleted')
  if (mail.r === true) reject('already_claimed', 'mail reward was already claimed')
  mail.r = true
  writeMails(context.state.save, mails)
  const count = grantMailGoods(context, mail)
  return {
    result: json({ mailId: payload.mailId, goods: mail.glb.map(good => ({ id: good.id, type: good.type, num: good.num })) }),
    events: [
      domainEvent('mail.claimed', { mailId: payload.mailId, count }),
      domainEvent('reward.granted', { source: 'mail', mailId: payload.mailId, count }),
    ],
  }
}

export function claimAllMail(context: HandlerContext): HandlerResult {
  requirePet(context.state)
  const mails = readMails(context.state.save)
  const ids: string[] = []
  for (const [id, raw] of Object.entries(mails)) {
    const mail = liveMail(raw)
    if (mail === null || mail.r === true) continue
    mail.r = true
    ids.push(id)
    grantMailGoods(context, mail)
  }
  if (ids.length === 0) reject('not_available', 'no mail rewards are available')
  writeMails(context.state.save, mails)
  return {
    result: json({ claimed: ids.length, mailIds: ids }),
    events: [
      domainEvent('mail.claimed', { mailIds: ids, count: ids.length }),
      domainEvent('reward.granted', { source: 'mail-all', count: ids.length }),
    ],
  }
}

export function deleteMail(context: HandlerContext, payload: CommandPayloadMap['mail.delete']): HandlerResult {
  requirePet(context.state)
  const mails = readMails(context.state.save)
  const mail = mails[payload.mailId]
  if (mail === undefined) reject('not_available', 'mail does not exist')
  if ('e' in mail) reject('already_claimed', 'mail was already deleted')
  if (mail.r !== true) reject('wrong_phase', 'only claimed mail may be deleted')
  mails[payload.mailId] = { d: mail.d, e: true, ...(mail.k === undefined ? {} : { k: mail.k }) }
  writeMails(context.state.save, mails)
  return {
    result: json({ mailId: payload.mailId, deleted: true }),
    events: [domainEvent('mail.claimed', { mailId: payload.mailId, deleted: true })],
  }
}

export function deleteAllMail(context: HandlerContext, payload: CommandPayloadMap['mail.deleteAll']): HandlerResult {
  requirePet(context.state)
  if (payload.scope !== 'claimed') reject('invalid_payload', 'unsupported mail delete scope')
  const mails = readMails(context.state.save)
  const ids: string[] = []
  for (const [id, mail] of Object.entries(mails)) {
    if ('e' in mail || mail.r !== true) continue
    mails[id] = { d: mail.d, e: true, ...(mail.k === undefined ? {} : { k: mail.k }) }
    ids.push(id)
  }
  writeMails(context.state.save, mails)
  return {
    result: json({ deleted: ids.length, mailIds: ids }),
    events: [domainEvent('mail.claimed', { deleted: ids.length, mailIds: ids })],
  }
}

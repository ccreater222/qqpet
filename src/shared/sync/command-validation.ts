import { assertJsonSafe } from '../pet-runtime/serialization'
import { assertTimeZone, isDayKey } from '../pet-runtime/time'
import type { CommandError, CommandKey, CommandPayloadMap, CommandRole, PetCommand } from './protocol'
import { validatePortablePetBundle } from './portable'
import {
  isBoolean,
  isEnum,
  isFiniteNumber,
  isNonEmptyString,
  isNonNegativeInteger,
  isRecord,
  isSafeInteger,
} from './schema'

type PayloadValidator = (value: unknown) => boolean
interface FieldRule {
  validate: PayloadValidator
  optional?: boolean
}

const field = (validate: PayloadValidator): FieldRule => ({ validate })
const optionalField = (validate: PayloadValidator): FieldRule => ({ validate, optional: true })
const emptyObject: PayloadValidator = value => isRecord(value) && Object.keys(value).length === 0
const positiveInteger: PayloadValidator = value => isSafeInteger(value) && value > 0

function objectWith(fields: Record<string, FieldRule>): PayloadValidator {
  return value => {
    if (isRecord(value) === false) return false
    for (const key of Object.keys(value)) {
      if (Object.prototype.hasOwnProperty.call(fields, key) === false) return false
    }
    for (const [key, rule] of Object.entries(fields)) {
      const present = Object.prototype.hasOwnProperty.call(value, key)
      if (present === false) {
        if (rule.optional === true) continue
        return false
      }
      if (rule.validate(value[key]) === false) return false
    }
    return true
  }
}

function denseArray(value: unknown, validateEntry: (entry: unknown) => boolean): boolean {
  if (Array.isArray(value) === false) return false
  for (let index = 0; index < value.length; index++) {
    if (Object.prototype.hasOwnProperty.call(value, index) === false) return false
    if (validateEntry(value[index]) === false) return false
  }
  return true
}

function nonNegativeIntegerArray(value: unknown): boolean {
  return denseArray(value, isNonNegativeInteger)
}

function nonEmptyNonNegativeIntegerArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && denseArray(value, isNonNegativeInteger)
}

function validTimeZone(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    assertTimeZone(value)
    return true
  } catch {
    return false
  }
}

function sharedSetting(value: unknown): boolean {
  if (isRecord(value) === false) return false
  const keys = Object.keys(value)
  if (keys.length !== 2 || Object.prototype.hasOwnProperty.call(value, 'key') === false) {
    return false
  }
  if (Object.prototype.hasOwnProperty.call(value, 'value') === false) return false
  if (value.key === 'difficulty') return value.value === 'easy' || value.value === 'standard'
  if (value.key === 'undying') return typeof value.value === 'boolean'
  return false
}

const commandPayloadValidators = {
  'pet.adopt': objectWith({ sex: field(v => isEnum(v, ['GG', 'MM'] as const)) }),
  'pet.reset': emptyObject,
  'pet.bury': emptyObject,
  'pet.rename': objectWith({ name: optionalField(isNonEmptyString), host: optionalField(isNonEmptyString) }),
  'pet.setPaused': objectWith({ paused: field(isBoolean) }),
  'pet.pokeFace': objectWith({ spotId: field(isNonEmptyString) }),
  'pet.cheer': emptyObject,
  'inventory.buy': objectWith({
    type: field(isNonEmptyString),
    itemId: field(isNonEmptyString),
    quantity: field(positiveInteger),
  }),
  'inventory.use': objectWith({
    type: field(isNonEmptyString),
    itemId: field(isNonEmptyString),
    quantity: optionalField(positiveInteger),
  }),
  'medical.treat': objectWith({
    mode: field(v => isEnum(v, ['doctor', 'owned'] as const)),
    itemId: optionalField(isNonEmptyString),
  }),
  'vip.buyPinkDiamond': objectWith({ days: field(positiveInteger) }),
  'vip.clearPinkDiamond': emptyObject,
  'vip.buySweetheart': objectWith({ days: field(positiveInteger) }),
  'vip.setSweetheart': objectWith({ enabled: field(isBoolean) }),
  'travel.completeCollection': emptyObject,
  'job.startWork': objectWith({ jobId: field(isNonEmptyString) }),
  'job.startStudy': objectWith({ courseId: field(isNonEmptyString) }),
  'job.startTravel': emptyObject,
  'activity.stop': emptyObject,
  'task.claim': objectWith({
    tab: field(v => isEnum(v, ['daily', 'ddw', 'growth', 'travel'] as const)),
    index: field(isNonNegativeInteger),
  }),
  'exam.start': objectWith({ subject: field(isNonEmptyString) }),
  'exam.submit': objectWith({ sessionToken: field(isNonEmptyString), answers: field(nonNegativeIntegerArray) }),
  'signin.sign': emptyObject,
  'signin.drawGrowth': emptyObject,
  'signin.claimOnlineGift': emptyObject,
  'signin.claimBirthdayGift': emptyObject,
  'mail.claim': objectWith({ mailId: field(isNonEmptyString) }),
  'mail.claimAll': emptyObject,
  'mail.delete': objectWith({ mailId: field(isNonEmptyString) }),
  'mail.deleteAll': objectWith({ scope: field(v => v === 'claimed') }),
  'game.startSession': objectWith({
    gameId: field(isNonEmptyString),
    kind: field(v => isEnum(v, ['small', 'flash'] as const)),
  }),
  'game.reward': objectWith({ sessionToken: field(isNonEmptyString) }),
  'diudiule.startSession': emptyObject,
  'diudiule.reward': objectWith({ sessionToken: field(isNonEmptyString) }),
  'game.abandonSession': objectWith({ sessionToken: field(isNonEmptyString) }),
  'social.completeLanVisit': objectWith({
    peerId: field(isNonEmptyString),
    direction: field(v => isEnum(v, ['incoming', 'outgoing'] as const)),
  }),
  'island.arriveScene': objectWith({ sceneId: field(isNonEmptyString) }),
  'island.acceptLetter': objectWith({ fromNpcId: field(isNonEmptyString), toNpcId: field(isNonEmptyString) }),
  'island.deliverLetter': objectWith({ toNpcId: field(isNonEmptyString) }),
  'island.turnInErrand': objectWith({
    npcId: field(isNonEmptyString),
    errandId: field(isNonEmptyString),
    itemId: optionalField(isNonEmptyString),
  }),
  'island.startQuiz': objectWith({ npcId: field(isNonEmptyString), errandId: field(isNonEmptyString) }),
  'island.answerQuiz': objectWith({ sessionToken: field(isNonEmptyString), optionIndex: field(isNonNegativeInteger) }),
  'island.fightMonster': objectWith({ monsterId: field(isNonEmptyString), tactic: field(isNonEmptyString) }),
  'island.claimGrowthReward': emptyObject,
  'island.claimTreasure': emptyObject,
  'island.giftNpc': objectWith({ npcId: field(isNonEmptyString), itemId: field(isNonEmptyString) }),
  'island.talkNpc': objectWith({ npcId: field(isNonEmptyString) }),
  'island.visitSpot': objectWith({ spotId: field(isNonEmptyString) }),
  'island.chat': objectWith({ npcId: field(isNonEmptyString) }),
  'island.playGame': objectWith({ gameKey: field(isNonEmptyString) }),
  'island.refreshNews': objectWith({ dayKey: field(v => typeof v === 'string' && isDayKey(v)) }),
  'fishing.buy': objectWith({ fryId: field(isNonNegativeInteger), quantity: field(positiveInteger) }),
  'fishing.feed': objectWith({ fishId: field(isNonNegativeInteger) }),
  'fishing.harvest': objectWith({ fishId: field(isNonNegativeInteger) }),
  'fishing.harvestAll': emptyObject,
  'fishing.speedUp': emptyObject,
  'farm.plant': objectWith({ seedId: field(isNonEmptyString), plotIds: field(nonEmptyNonNegativeIntegerArray) }),
  'farm.harvest': objectWith({ plotIds: field(nonEmptyNonNegativeIntegerArray) }),
  'farm.care': objectWith({
    plotIds: field(nonEmptyNonNegativeIntegerArray),
    action: field(v => isEnum(v, ['water', 'weed', 'pest', 'fertilize'] as const)),
  }),
  'farm.clear': objectWith({ plotIds: field(nonEmptyNonNegativeIntegerArray) }),
  'farm.buySeed': objectWith({ seedId: field(isNonEmptyString), quantity: field(positiveInteger) }),
  'farm.sellProduce': objectWith({ itemId: field(isNonEmptyString), quantity: field(positiveInteger) }),
  'settings.setShared': sharedSetting,
  'server.setAdvanceWhileEmpty': objectWith({ enabled: field(isBoolean) }),
  'server.setTimeZone': objectWith({ timeZone: field(validTimeZone) }),
  'server.setWeatherCity': objectWith({ city: field(isNonEmptyString) }),
  'device.list': emptyObject,
  'device.revoke': objectWith({ deviceId: field(isNonEmptyString) }),
  'admin.exportForDetach': emptyObject,
  'admin.resumeServer': objectWith({
    expectedEpoch: field(isNonNegativeInteger),
    bundle: field(validatePortablePetBundle),
    allowClamp: optionalField(isBoolean),
    rebindLocalSessions: optionalField(isBoolean),
  }),
  'admin.importPortableBundle': objectWith({
    bundle: field(validatePortablePetBundle),
    allowClamp: optionalField(isBoolean),
    rebindLocalSessions: optionalField(isBoolean),
  }),
  'admin.grantCheat': objectWith({
    stat: field(v => isEnum(v, ['yb', 'growth', 'mood', 'hunger', 'clean', 'health'] as const)),
    amount: field(isFiniteNumber),
  }),
  'admin.grantRandomGoods': objectWith({ type: field(isNonEmptyString), quantity: field(positiveInteger) }),
} satisfies Record<CommandKey, PayloadValidator>

export const COMMAND_TYPES = Object.keys(commandPayloadValidators) as CommandKey[]
const COMMAND_TYPE_SET = new Set<string>(COMMAND_TYPES)
const guardedValidators: Partial<Record<CommandKey, (value: unknown) => boolean>> = {}
for (const commandType of COMMAND_TYPES) {
  guardedValidators[commandType] = value => {
    try {
      assertJsonSafe(value)
    } catch {
      return false
    }
    return commandPayloadValidators[commandType](value)
  }
}
export const COMMAND_PAYLOAD_VALIDATORS = guardedValidators as {
  [K in CommandKey]: (value: unknown) => value is CommandPayloadMap[K]
}

const OWNER_COMMANDS = new Set<CommandKey>([
  'pet.adopt',
  'pet.reset',
  'server.setAdvanceWhileEmpty',
  'server.setTimeZone',
  'server.setWeatherCity',
  'device.list',
  'device.revoke',
  'admin.importPortableBundle',
  'admin.exportForDetach',
  'admin.resumeServer',
  'admin.grantCheat',
  'admin.grantRandomGoods',
])

export const COMMAND_ROLES = Object.fromEntries(
  COMMAND_TYPES.map(commandType => [commandType, OWNER_COMMANDS.has(commandType) ? 'owner' : 'player']),
) as Record<CommandKey, CommandRole>

export function commandRole(commandType: CommandKey): CommandRole {
  return COMMAND_ROLES[commandType]
}

export function isOwnerCommand(commandType: CommandKey): boolean {
  return COMMAND_ROLES[commandType] === 'owner'
}

export function isCommandKey(value: unknown): value is CommandKey {
  return typeof value === 'string' && COMMAND_TYPE_SET.has(value)
}

export function validateCommandPayload<K extends CommandKey>(commandType: K, payload: unknown): payload is CommandPayloadMap[K] {
  return COMMAND_PAYLOAD_VALIDATORS[commandType](payload)
}

export type CommandValidationResult =
  | { ok: true; command: PetCommand }
  | { ok: false; error: CommandError }

function invalidPayload(message: string): CommandValidationResult {
  return {
    ok: false,
    error: { code: 'invalid_payload', message, refreshProjection: false },
  }
}

export function parsePetCommand(value: unknown): CommandValidationResult {
  if (isRecord(value) === false) return invalidPayload('command must be an object')
  for (const key of Object.keys(value)) {
    if (key !== 'type' && key !== 'payload') return invalidPayload('command has an unknown field: ' + key)
  }
  if (isCommandKey(value.type) === false) return invalidPayload('unknown command type')
  const payload = value.payload
  if (validateCommandPayload(value.type, payload) === false) {
    return invalidPayload('invalid payload for ' + value.type)
  }
  return { ok: true, command: { type: value.type, payload } as PetCommand }
}

export function assertPetCommand(value: unknown): asserts value is PetCommand {
  const parsed = parsePetCommand(value)
  if (parsed.ok === false) throw new Error(parsed.error.code + ': ' + parsed.error.message)
}

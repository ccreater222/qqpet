import type { CommandKey, CommandPayloadMap, PetCommand } from '../../shared/sync/protocol'
import type { Sex } from '../../shared/save'

type CommandFor<K extends CommandKey> = Extract<PetCommand, { type: K }>

function command<K extends CommandKey>(type: K, payload: CommandPayloadMap[K]): CommandFor<K> {
  return { type, payload } as CommandFor<K>
}

/** Pure intent-to-command mapping for C6b Groups A–D UI actions. */
export const uiCommands = {
  adopt: (sex: Sex): CommandFor<'pet.adopt'> => command('pet.adopt', { sex }),
  reset: (): CommandFor<'pet.reset'> => command('pet.reset', {}),
  bury: (): CommandFor<'pet.bury'> => command('pet.bury', {}),
  rename: (payload: CommandPayloadMap['pet.rename']): CommandFor<'pet.rename'> => command('pet.rename', payload),
  setPaused: (paused: boolean): CommandFor<'pet.setPaused'> => command('pet.setPaused', { paused }),
  pokeFace: (spotId: string): CommandFor<'pet.pokeFace'> => command('pet.pokeFace', { spotId }),
  cheer: (): CommandFor<'pet.cheer'> => command('pet.cheer', {}),

  buy: (type: string, itemId: string, quantity = 1): CommandFor<'inventory.buy'> =>
    command('inventory.buy', { type, itemId, quantity }),
  use: (type: string, itemId: string, quantity?: number): CommandFor<'inventory.use'> =>
    command('inventory.use', { type, itemId, ...(quantity === undefined ? {} : { quantity }) }),
  treatDoctor: (): CommandFor<'medical.treat'> => command('medical.treat', { mode: 'doctor' }),
  treatOwned: (itemId: string): CommandFor<'medical.treat'> => command('medical.treat', { mode: 'owned', itemId }),
  buyPinkDiamond: (days: number): CommandFor<'vip.buyPinkDiamond'> => command('vip.buyPinkDiamond', { days }),
  clearPinkDiamond: (): CommandFor<'vip.clearPinkDiamond'> => command('vip.clearPinkDiamond', {}),
  buySweetheart: (days: number): CommandFor<'vip.buySweetheart'> => command('vip.buySweetheart', { days }),
  setSweetheart: (enabled: boolean): CommandFor<'vip.setSweetheart'> => command('vip.setSweetheart', { enabled }),

  startWork: (jobId: string): CommandFor<'job.startWork'> => command('job.startWork', { jobId }),
  startStudy: (courseId: string): CommandFor<'job.startStudy'> => command('job.startStudy', { courseId }),
  startTravel: (): CommandFor<'job.startTravel'> => command('job.startTravel', {}),
  stopActivity: (): CommandFor<'activity.stop'> => command('activity.stop', {}),
  claimTask: (tab: CommandPayloadMap['task.claim']['tab'], index: number): CommandFor<'task.claim'> =>
    command('task.claim', { tab, index }),
  examStart: (subject: string): CommandFor<'exam.start'> => command('exam.start', { subject }),
  examSubmit: (sessionToken: string, answers: number[]): CommandFor<'exam.submit'> =>
    command('exam.submit', { sessionToken, answers }),
  completeTravelCollection: (): CommandFor<'travel.completeCollection'> =>
    command('travel.completeCollection', {}),

  gameStart: (gameId: string, kind: 'small' | 'flash'): CommandFor<'game.startSession'> =>
    command('game.startSession', { gameId, kind }),
  gameReward: (sessionToken: string): CommandFor<'game.reward'> => command('game.reward', { sessionToken }),
  gameAbandon: (sessionToken: string): CommandFor<'game.abandonSession'> =>
    command('game.abandonSession', { sessionToken }),
  diudiuleStart: (): CommandFor<'diudiule.startSession'> => command('diudiule.startSession', {}),
  diudiuleReward: (sessionToken: string): CommandFor<'diudiule.reward'> =>
    command('diudiule.reward', { sessionToken }),

  fishingBuy: (fryId: number, quantity: number): CommandFor<'fishing.buy'> =>
    command('fishing.buy', { fryId, quantity }),
  fishingFeed: (fishId: number): CommandFor<'fishing.feed'> => command('fishing.feed', { fishId }),
  fishingHarvest: (fishId: number): CommandFor<'fishing.harvest'> => command('fishing.harvest', { fishId }),
  fishingHarvestAll: (): CommandFor<'fishing.harvestAll'> => command('fishing.harvestAll', {}),
  fishingSpeedUp: (): CommandFor<'fishing.speedUp'> => command('fishing.speedUp', {}),

  socialVisit: (peerId: string, direction: 'incoming' | 'outgoing'): CommandFor<'social.completeLanVisit'> =>
    command('social.completeLanVisit', { peerId, direction }),

  islandArriveScene: (sceneId: string): CommandFor<'island.arriveScene'> =>
    command('island.arriveScene', { sceneId }),
  islandAcceptLetter: (fromNpcId: string, toNpcId: string): CommandFor<'island.acceptLetter'> =>
    command('island.acceptLetter', { fromNpcId, toNpcId }),
  islandDeliverLetter: (toNpcId: string): CommandFor<'island.deliverLetter'> =>
    command('island.deliverLetter', { toNpcId }),
  islandTurnInErrand: (npcId: string, errandId: string, itemId?: string): CommandFor<'island.turnInErrand'> =>
    command('island.turnInErrand', { npcId, errandId, ...(itemId === undefined ? {} : { itemId }) }),
  islandStartQuiz: (npcId: string, errandId: string): CommandFor<'island.startQuiz'> =>
    command('island.startQuiz', { npcId, errandId }),
  islandAnswerQuiz: (sessionToken: string, optionIndex: number): CommandFor<'island.answerQuiz'> =>
    command('island.answerQuiz', { sessionToken, optionIndex }),
  islandFightMonster: (monsterId: string, tactic: string): CommandFor<'island.fightMonster'> =>
    command('island.fightMonster', { monsterId, tactic }),
  islandClaimGrowthReward: (): CommandFor<'island.claimGrowthReward'> =>
    command('island.claimGrowthReward', {}),
  islandClaimTreasure: (): CommandFor<'island.claimTreasure'> =>
    command('island.claimTreasure', {}),
  islandGiftNpc: (npcId: string, itemId: string): CommandFor<'island.giftNpc'> =>
    command('island.giftNpc', { npcId, itemId }),
  islandTalkNpc: (npcId: string): CommandFor<'island.talkNpc'> =>
    command('island.talkNpc', { npcId }),
  islandVisitSpot: (spotId: string): CommandFor<'island.visitSpot'> =>
    command('island.visitSpot', { spotId }),
  islandChat: (npcId: string): CommandFor<'island.chat'> =>
    command('island.chat', { npcId }),
  islandPlayGame: (gameKey: string): CommandFor<'island.playGame'> =>
    command('island.playGame', { gameKey }),
  islandRefreshNews: (dayKey: string): CommandFor<'island.refreshNews'> =>
    command('island.refreshNews', { dayKey }),

  farmBuySeed: (seedId: string, quantity: number): CommandFor<'farm.buySeed'> =>
    command('farm.buySeed', { seedId, quantity }),
  farmBuyFertilizer: (fertilizerId: string, quantity: number): CommandFor<'farm.buyFertilizer'> =>
    command('farm.buyFertilizer', { fertilizerId, quantity }),
  farmPlant: (seedId: string, plotIds: number[]): CommandFor<'farm.plant'> =>
    command('farm.plant', { seedId, plotIds }),
  farmReclaim: (plotIds: number[]): CommandFor<'farm.reclaim'> =>
    command('farm.reclaim', { plotIds }),
  farmCare: (plotIds: number[], action: 'water' | 'weed' | 'pest' | 'fertilize'): CommandFor<'farm.care'> =>
    command('farm.care', { plotIds, action }),
  farmHarvest: (plotIds: number[]): CommandFor<'farm.harvest'> => command('farm.harvest', { plotIds }),
  farmClear: (plotIds: number[]): CommandFor<'farm.clear'> => command('farm.clear', { plotIds }),
  farmSellProduce: (itemId: string, quantity: number): CommandFor<'farm.sellProduce'> =>
    command('farm.sellProduce', { itemId, quantity }),

  signIn: (): CommandFor<'signin.sign'> => command('signin.sign', {}),
  drawGrowth: (): CommandFor<'signin.drawGrowth'> => command('signin.drawGrowth', {}),
  claimOnlineGift: (): CommandFor<'signin.claimOnlineGift'> => command('signin.claimOnlineGift', {}),
  claimBirthdayGift: (): CommandFor<'signin.claimBirthdayGift'> => command('signin.claimBirthdayGift', {}),
  mailClaim: (mailId: string): CommandFor<'mail.claim'> => command('mail.claim', { mailId }),
  mailClaimAll: (): CommandFor<'mail.claimAll'> => command('mail.claimAll', {}),
  mailDelete: (mailId: string): CommandFor<'mail.delete'> => command('mail.delete', { mailId }),
  mailDeleteAll: (): CommandFor<'mail.deleteAll'> => command('mail.deleteAll', { scope: 'claimed' }),

  setShared: (key: 'difficulty' | 'undying', value: boolean | 'easy' | 'standard'): CommandFor<'settings.setShared'> =>
    command('settings.setShared', { key, value }),
  grantCheat: (stat: CommandPayloadMap['admin.grantCheat']['stat'], amount: number): CommandFor<'admin.grantCheat'> =>
    command('admin.grantCheat', { stat, amount }),
  grantRandomGoods: (type: string, quantity: number): CommandFor<'admin.grantRandomGoods'> =>
    command('admin.grantRandomGoods', { type, quantity }),
} as const

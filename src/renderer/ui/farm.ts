import { avatar, info, onProjectionApplied, onSaveFlush, runtimeProjectionMode, save, scaleYb, setInfo, update } from '../pet/store'
import { registerProjectionCacheInvalidator } from '../pet/projection-cache'
import { uiCommands } from '../pet/command-map'
import { commandErrorText, commandSucceeded, dispatchRuntimeCommand } from '../pet/runtime-command'
import FARM from '../../shared/pet-runtime/content/farm.json'
import { SwfPlayer } from '../swf/player'
import { readSol, writeSol, type Sol } from '../swf/sol'
import { openBox } from './box'
import './css/farm.css'
import { button, div, img } from './dom'

// Farm.swf keeps everything in SharedObject.getLocal("test", "/"); Ruffle names it after the SWF's host.
const KEY = `${location.hostname}//test`
const MIGRATED = 'farm:migrated'
/** InstallFace.PEST_TIME: each disaster strikes a growing plot about once in this many seconds. */
const PEST_TIME = 14400

/** A plot as Farm.swf saves it: `time` is when it was sown, `harvest` marks one already picked. */
interface Land {
  farmland: string
  crop?: string
  time?: number
  harvest?: unknown
  grass?: number
  worm?: number
}

// Farms used to live only in localStorage; adopt one once, at startup, so a later reset or import can't pick up a stale one.
if (runtimeProjectionMode === false && localStorage.getItem(MIGRATED) === null) {
  const legacy = readSol(KEY)?.user
  if (legacy && !save.saveJsonData.farm) update('saveJsonData', { farm: JSON.stringify(legacy) })
  localStorage.setItem(MIGRATED, '1')
}

let open = false
let farmStale = false
let closeFarm: (() => void) | null = null

interface RuntimeSeed { seed: string; name: string; price: number; rank: number }
interface RuntimeCrop { seed: string; crop: string; name: string; time: number; price: number }
interface RuntimeLand { farmland: string; crop?: string; time?: number; harvest?: unknown; grass?: number; worm?: number; state?: number; progress?: number; yield?: number }
interface RuntimeFarm {
  experience?: string | number
  rank?: string | number
  weather?: string
  wealth?: string | number
  burden?: { name?: string; Items: string; number: number }[]
  warehouse?: { fruit: string; number: number; name?: string; price?: number }[]
  farmland?: RuntimeLand[]
}

const RUNTIME_SEEDS = FARM.seeds as RuntimeSeed[]
const RUNTIME_CROPS = FARM.crops as RuntimeCrop[]

function runtimeFarmState(): RuntimeFarm {
  try {
    const parsed = JSON.parse(save.saveJsonData.farm || '{}') as RuntimeFarm
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function runtimeLandLabel(land: RuntimeLand, index: number): string {
  const crop = land.crop === undefined ? undefined : RUNTIME_CROPS.find((entry) => entry.seed === land.crop)
  if (land.harvest !== undefined) return `${index + 1} 已收获`
  if (land.crop === undefined) return `${index + 1} ${land.farmland === 'Wasteland' ? '荒地' : '空地'}`
  if (Number(land.state ?? 0) >= 5) return `${index + 1} ${crop?.name ?? land.crop} 可收获`
  const progress = Math.max(0, Math.min(100, Math.round(Number(land.progress ?? 0) * 100)))
  return `${index + 1} ${crop?.name ?? land.crop} ${progress}%${land.grass === undefined ? '' : ' 草'}${land.worm === undefined ? '' : ' 虫'}${land.farmland === 'FarmlandG' ? ' 旱' : ''}`
}

/** Projection-only plot labels; exported for the focused farm tests. */
export function runtimeFarmPlotLabels(stored: string | undefined): string[] {
  let parsed: RuntimeFarm = {}
  try {
    parsed = stored ? JSON.parse(stored) as RuntimeFarm : {}
  } catch {
    parsed = {}
  }
  const plots = parsed.farmland ?? []
  return Array.from({ length: 18 }, (_, index) => runtimeLandLabel(plots[index] ?? { farmland: index < 6 ? 'FarmlandS' : 'Wasteland' }, index))
}

function openRuntimeFarm(): void {
  open = true
  farmStale = false
  let selectedSeed = RUNTIME_SEEDS[0]?.seed ?? ''
  const selected = new Set<number>()
  let message = '选择种子和地块后操作，结果以下一次投影为准'
  const host = div('ui-farm-runtime')
  const render = (): void => {
    const state = runtimeFarmState()
    host.textContent = ''
    const rank = Number(state.rank ?? 1)
    host.append(div('farmHeader', `农场 Lv${rank} 经验${state.experience ?? 0} 天气${state.weather ?? 'Sunny'} 元宝${state.wealth ?? info.yb}`))
    const send = (command: unknown, ok: string): void => {
      void dispatchRuntimeCommand(command as never).then((result) => {
        message = commandSucceeded(result) ? ok : (result !== null && result.status === 'rejected' ? commandErrorText(result.error) : '操作失败')
        render()
      })
    }
    const seeds = div('farmSeeds')
    for (const seed of RUNTIME_SEEDS) {
      const owned = state.burden?.find((entry) => entry.Items === seed.seed)?.number ?? 0
      seeds.append(button(`farmSeed${seed.seed === selectedSeed ? ' selected' : ''}`, () => { selectedSeed = seed.seed; render() }, `${seed.name} ${seed.price}元宝 有${owned}`))
    }
    host.append(seeds)
    const labels = runtimeFarmPlotLabels(save.saveJsonData.farm)
    const grid = div('farmPlots')
    for (let index = 0; index < 18; index++) {
      grid.append(button(`farmPlot${selected.has(index) ? ' selected' : ''}`, () => {
        if (selected.has(index)) selected.delete(index)
        else selected.add(index)
        render()
      }, labels[index]))
    }
    host.append(grid)
    const chosen = (): number[] => [...selected]
    const plotAction = (label: string, make: () => unknown, ok: string): HTMLDivElement =>
      button('farmAct', () => {
        if (selected.size === 0) { message = '请先选择地块'; render(); return }
        send(make(), ok)
      }, label)
    host.append(div(
      'farmActions',
      button('farmAct', () => send(uiCommands.farmBuySeed(selectedSeed, 1), '购买成功'), '买1种子'),
      plotAction('播种', () => uiCommands.farmPlant(selectedSeed, chosen()), '播种成功'),
      plotAction('浇水', () => uiCommands.farmCare(chosen(), 'water'), '浇水完成'),
      plotAction('除草', () => uiCommands.farmCare(chosen(), 'weed'), '除草完成'),
      plotAction('除虫', () => uiCommands.farmCare(chosen(), 'pest'), '除虫完成'),
      plotAction('收获', () => uiCommands.farmHarvest(chosen()), '收获成功'),
      plotAction('铲除', () => uiCommands.farmClear(chosen()), '铲除成功'),
    ))
    const warehouse = div('farmWarehouse', '仓库：')
    for (const item of state.warehouse ?? []) {
      warehouse.append(button('farmAct', () => send(uiCommands.farmSellProduce(item.fruit, 1), `出售${item.name ?? item.fruit}成功`), `${item.name ?? item.fruit}×${item.number} 售1`))
    }
    host.append(warehouse)
    host.append(div('farmStatus', message))
  }
  const off = onProjectionApplied(() => render())
  window.qqpet.setFocusable(true)
  closeFarm = openBox(host, {
    onClose: () => {
      off()
      closeFarm = null
      open = false
      window.qqpet.setFocusable(false)
    },
  })
  render()
}

/** The save Farm.swf writes on its first run (FarmMain.locationInit). */
function fresh(): Sol {
  return {
    house: 'house',
    kennel: 'kennel',
    fence: 'fence',
    experience: '1',
    rank: '01',
    burden: [],
    warehouse: [],
    farmland: Array.from({ length: 18 }, (_, i) => ({ farmland: i < 6 ? 'FarmlandS' : 'Wasteland' })),
    weather: 'Sunny',
  }
}

/**
 * QQ 农场 (pet/qqfarm/Farm.swf). The farm is kept in saveJsonData.farm so it
 * follows the pet through export, import and reset; localStorage only feeds
 * the running SWF. Its 金币 are the pet's 元宝: the save gets the current yb
 * before the SWF reads it, and every change the SWF flushes is settled as a
 * delta, so yb earned or spent elsewhere meanwhile is kept.
 * Ruffle assigns localStorage[key] directly, so writes can only be polled.
 */
export function openFarm(): void {
  if (open) return
  if (runtimeProjectionMode) {
    openRuntimeFarm()
    return
  }
  open = true
  farmStale = false
  const stored = save.saveJsonData.farm
  const user: Sol = { ...(stored ? JSON.parse(stored) : fresh()), username: info.name, wealth: String(info.yb) }
  writeSol(KEY, 'test', { user })

  let last = info.yb
  let raw = localStorage.getItem(KEY)
  const settle = (): void => {
    if (localStorage.getItem(KEY) === raw) return
    raw = localStorage.getItem(KEY)
    const user = readSol(KEY)!.user as Sol
    const w = Number(user.wealth)
    // The SWF only knows the yb it started with; spending elsewhere meanwhile can overdraw.
    const d = w - last
    setInfo('yb', Math.max(0, info.yb + (d > 0 ? scaleYb(d) : d)))
    last = w
    update('saveJsonData', { farm: JSON.stringify(user) })
  }
  const timer = setInterval(settle, 500)
  const flushFarm = (): void => {
    settle()
    // Keep exported/live snapshots from applying the same elapsed pest interval twice after import.
    const user = readSol(KEY)!.user as Sol
    update('saveJsonData', { farm: JSON.stringify({ ...user, checked: Math.floor(Date.now() / 1000) }) })
  }
  const stopFlush = onSaveFlush(flushFarm)

  const host = div('farm', div('avatar', img('penguin_breathe', avatar())))
  const player = new SwfPlayer(host)
  // FarmlandControl.farmAll: the movie runs the action on every plot and shows the outcome itself.
  const all = (action: string) => async () => void (await player.callback('farmAll'))(action)
  const actions = div(
    'actions',
    button('fcc wsnw act', all('harvest'), '一键收获'),
    button('fcc wsnw act', all('care'), '一键照料'),
    button('fcc wsnw act', all('clear'), '一键铲除'),
    button('fcc wsnw act', all('plant'), '一键播种'),
    button('fcc wsnw act', async () => void (await player.callback('farmView'))(), '全景/原尺寸'),
  )
  window.qqpet.setFocusable(true)
  closeFarm = openBox(div('ui-farm', host, actions), {
    onClose: () => {
      clearInterval(timer)
      if (farmStale === false) flushFarm()
      stopFlush()
      window.qqpet.setFocusable(false)
      open = false
      closeFarm = null
    },
  })
  void player.load('pet/qqfarm/Farm.swf', 'pet/qqfarm/')
}

// A remote farm projection invalidates the running SWF's scratch state. Close
// the panel rather than letting stale local SWF bytes overwrite canonical farm
// state on the next settle; the next open starts from the projection.
registerProjectionCacheInvalidator('farm', () => {
  // Runtime mode re-renders from the projection instead of closing the panel.
  if (runtimeProjectionMode) return
  if (open === false) return
  farmStale = true
  closeFarm?.()
})

let ripening: Promise<Record<string, number>> | undefined

/** Seconds each seed takes to ripen. */
async function ripeTimes(): Promise<Record<string, number>> {
  const xml = await (await fetch('pet/qqfarm/com/MyFarm/data/xml/Crop.xml')).text()
  const items = new DOMParser().parseFromString(xml, 'text/xml').querySelectorAll('items')
  return Object.fromEntries([...items].map((e) => [e.getAttribute('seed'), Number(e.getAttribute('time'))]))
}

/**
 * The closed farm as the pet sees it: ripe plots, and growing plots hit by
 * weeds, insects or drought. Farm.swf only rolls disasters while it runs, so
 * this rolls them for the time since it last did, the same way
 * (InstallFace.tick). Null while the farm is open or was never started.
 */
export async function farmNews(): Promise<{ ripe: number; pests: number } | null> {
  if (runtimeProjectionMode) {
    if (open) return null
    const stored = save.saveJsonData.farm
    if (stored === undefined || stored === '') return null
    let user: RuntimeFarm
    try {
      user = JSON.parse(stored) as RuntimeFarm
    } catch {
      return null
    }
    const now = Math.floor(Date.now() / 1000)
    let ripe = 0
    let pests = 0
    for (const land of user.farmland ?? []) {
      if (land.crop === undefined || land.harvest !== undefined) continue
      const crop = RUNTIME_CROPS.find((entry) => entry.seed === land.crop)
      if (Number(land.state ?? 0) >= 5 || (crop !== undefined && now - Number(land.time ?? now) >= crop.time)) { ripe++; continue }
      if (land.grass !== undefined || land.worm !== undefined || land.farmland === 'FarmlandG') pests++
    }
    return { ripe, pests }
  }
  ripening ??= ripeTimes()
  const times = await ripening
  const stored = save.saveJsonData.farm
  if (open || !stored) return null
  const user: Sol = JSON.parse(stored)
  const now = Math.floor(Date.now() / 1000)
  const chance = 1 - Math.exp(-(now - Number(user.checked ?? now)) / PEST_TIME)
  const roll = (): boolean => Math.random() < chance
  let ripe = 0
  let pests = 0
  for (const land of user.farmland as Land[]) {
    if (!land.crop || land.harvest !== undefined) continue
    if (now - Number(land.time) >= times[land.crop]) {
      ripe++
      continue
    }
    if (land.grass === undefined && roll()) land.grass = 1
    if (land.worm === undefined && roll()) land.worm = 1
    if (land.farmland === 'FarmlandS' && roll()) land.farmland = 'FarmlandG'
    if (land.grass !== undefined || land.worm !== undefined || land.farmland === 'FarmlandG') pests++
  }
  user.checked = now
  update('saveJsonData', { farm: JSON.stringify(user) })
  return { ripe, pests }
}

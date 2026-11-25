// The phone pet profile. The desktop window (ui/petinfo.ts) is a 432x420 box of
// absolute-positioned rows: on a 412 dp phone the 442 px frame is wider than the
// screen (its stats grid and 保存 keys clip off the right edge), and once the
// frame is scaled instead its 12 px text is 10.8 dp with 18 dp inputs. This page
// keeps the same store reads, the same rename command and the same live refresh,
// but lays the profile out as a bottom sheet at 1 CSS px = 1 dp: a 96 dp avatar
// with the name/level beside it, 44 dp rename fields, and two-column stat grids
// (label 13, value 15, 20 dp meters). The desktop window is untouched.
import { goodOf } from '../../pet/data/goods'
import { diploma } from '../../pet/jobs'
import { avatar, fatigue, growthPerMinute, info, luck, runtimeProjectionMode, save, setInfo } from '../../pet/store'
import { uiCommands } from '../../pet/command-map'
import { commandSucceeded, dispatchRuntimeCommand } from '../../pet/runtime-command'
import { formatDate } from '../date'
import { div, img, typeable } from '../dom'
import { age, status } from '../state'
import {
  abilityEntries,
  sexLabel,
  statGrid,
  statusEntries,
  statusLabel,
  type PetNumbers,
  type StatEntry,
} from './phone-pages-model'
import { openSheet, type SheetHandle } from './sheet'

/** The open phone profile, so a second request replaces it instead of stacking sheets. */
let current: SheetHandle | null = null

const activate = (el: HTMLElement, run: () => void): void => {
  el.addEventListener('click', run)
  el.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    run()
  })
}

/** Every number the profile prints, read once per refresh. */
const snapshot = (): PetNumbers => {
  const computed = save.petComputedlInfo
  return {
    level: computed.level,
    yb: info.yb,
    diamond: info.diamond,
    intel: info.intel,
    strong: info.strong,
    charm: info.charm,
    growth: info.growth,
    upGrowth: computed.upGrowth,
    nextGrowth: computed.nextGrowth,
    hunger: info.hunger,
    hungerMax: computed.hungerMax,
    clean: info.clean,
    cleanMax: computed.cleanMax,
    health: info.health,
    healthMax: computed.healthMax,
    mood: info.mood,
    moodMax: computed.moodMax,
    age: age(info.onLineTime | 0),
    growthPerHour: growthPerMinute() * 60,
    status: statusLabel(status()),
    onlineMinutes: info.onlineDataTime | 0,
    pd: info.pinkDiamond
      ? `${info.PDiamondYear ? '年费，' : ''}${formatDate(info.PDiamondExpirationDate, 'YYYY-MM-DD HH:mm')}到期`
      : '未开通',
    sweetHeart: info.sweetHeartOverTime ? `${formatDate(info.sweetHeartOverTime, 'YYYY-MM-DD HH:mm')}到期` : '未开通',
  }
}

interface Readout {
  value: HTMLElement
  /** The meter fill of a bar entry, null for a plain value. */
  fill: HTMLElement | null
  /** Care meters are graded green/yellow/red; other bars stay orange. */
  graded: boolean
}

/**
 * Opens the phone pet-profile sheet. Renaming goes through the desktop's own
 * `rename` command / `setInfo`; the interval only rewrites text and meter widths,
 * so a half-typed nickname or a focused input survives the refresh.
 */
export function openPhonePetInfo(): void {
  current?.close()
  current = null

  let sheet: SheetHandle | null = null
  let alive = true
  const body = div('qp-petinfo')

  // ---- header: avatar, name, level, membership -----------------------------

  const portrait = img('qp-petinfo-avatar', avatar())
  const avatarWrap = div('qp-petinfo-avatar-wrap', portrait)
  const nameEl = div('qp-petinfo-name')
  const metaEl = div('qp-petinfo-meta')
  const moodEl = div('qp-petinfo-meta')
  const pdBadge = div('qp-petinfo-badge')
  const pdText = div('', '')
  const pdTag = div('qp-petinfo-tag', pdBadge, pdText)
  const heartIcon = div('qp-petinfo-heart')
  const heartText = div('', '')
  const heartTag = div('qp-petinfo-tag', heartIcon, heartText)
  body.append(
    div(
      'qp-petinfo-head',
      avatarWrap,
      div('qp-petinfo-who', nameEl, metaEl, moodEl, div('qp-petinfo-tags', pdTag, heartTag)),
    ),
  )

  // ---- rename: 44 dp fields, desktop rules ---------------------------------

  const renameRow = (label: string, key: 'name' | 'host', after: () => void): HTMLElement => {
    const input = typeable(Object.assign(document.createElement('input'), { className: 'qp-petinfo-input', type: 'text', maxLength: 20, value: info[key] }))
    const saveButton = div('qp-petinfo-save', '保存')
    saveButton.setAttribute('role', 'button')
    saveButton.setAttribute('aria-label', `保存${label}`)
    saveButton.tabIndex = 0
    activate(saveButton, () => {
      const value = input.value.trim()
      if (value.length === 0) return void (input.value = info[key])
      if (runtimeProjectionMode) {
        const payload = key === 'name' ? { name: value } : { host: value }
        void dispatchRuntimeCommand(uiCommands.rename(payload)).then((result) => {
          if (commandSucceeded(result)) after()
        })
        return
      }
      setInfo(key, value)
      after()
    })
    return div('qp-petinfo-field', div('qp-petinfo-field-label', label), input, saveButton)
  }
  body.append(
    div(
      'qp-petinfo-section',
      div('qp-petinfo-section-title', '昵称'),
      div('qp-petinfo-form', renameRow('宠物昵称', 'name', syncWho), renameRow('主人昵称', 'host', syncWho)),
    ),
  )

  // ---- two-column stat grids ----------------------------------------------

  const readouts: Readout[] = []

  /** A value cell, plus a 20 dp meter when the entry carries a ratio. */
  function statCell(entry: StatEntry, graded: boolean): HTMLElement {
    const value = div('qp-petinfo-value')
    const cell = div('qp-petinfo-stat', div('qp-petinfo-label', entry.label), value)
    let fill: HTMLElement | null = null
    if (entry.ratio !== undefined) {
      fill = div('qp-petinfo-meter-fill')
      cell.append(div('qp-petinfo-meter', fill))
    }
    readouts.push({ value, fill, graded })
    return cell
  }

  /** The rows of a grid, padded with empties so the last row keeps two columns. */
  const grid = (entries: readonly StatEntry[], graded: (entry: StatEntry) => boolean): HTMLElement =>
    div(
      'qp-petinfo-grid',
      ...statGrid(entries).flatMap((row) =>
        row.map((entry) => (entry ? statCell(entry, graded(entry)) : div('qp-petinfo-stat qp-petinfo-stat-blank'))),
      ),
    )

  body.append(
    div('qp-petinfo-section', div('qp-petinfo-section-title', '个人能力'), grid(abilityEntries(snapshot()), () => false)),
    // The care meters keep the desktop's green/yellow/red grading at 60% / 20%.
    div('qp-petinfo-section', div('qp-petinfo-section-title', '宠物状态'), grid(statusEntries(snapshot()), (entry) => entry.id !== 'growth' && entry.id !== 'age' && entry.ratio !== undefined)),
  )

  // ---- diplomas and achievements ------------------------------------------

  const diplomas = Object.entries(save.studyInfo)
    .map(([key, value]) => diploma(key, value))
    .filter((text): text is string => Boolean(text))
  body.append(
    div(
      'qp-petinfo-section',
      div('qp-petinfo-section-title', '学历'),
      diplomas.length
        ? div('qp-petinfo-diplomas', ...diplomas.map((text) => div('qp-petinfo-diploma', text)))
        : div('qp-petinfo-empty', '还没有获得学历，去学习吧'),
    ),
  )

  const achievements: [string, string, number][] = [
    ['pet/achievement/travel.svg', '旅行成就', save.gameSaveDatas.travel_china_num],
    ['pet/achievement/ddw.svg', '逗宠成就', save.gameSaveDatas.ddw],
    ['pet/achievement/yyds.svg', '养鱼大师', save.gameSaveDatas.yyds],
  ]
  const earned = achievements.filter(([, , count]) => Boolean(count))
  body.append(
    div(
      'qp-petinfo-section',
      div('qp-petinfo-section-title', '成就'),
      earned.length
        ? div(
            'qp-petinfo-ach',
            ...earned.map(([src, title, count]) =>
              div('qp-petinfo-ach-item', Object.assign(img('qp-petinfo-ach-img', src), { title: `${title}*${count}` }), div('', `${title}*${count}`)),
            ),
          )
        : div('qp-petinfo-empty', '还没有获得成就'),
    ),
  )

  // ---- live refresh: text and widths only ---------------------------------

  /** The name, level, luck and membership line; the desktop refreshes these once a second. */
  function syncWho(): void {
    nameEl.textContent = `${info.host}家的${info.name}`
    metaEl.textContent = `Lv.${save.petComputedlInfo.level} · ${sexLabel(info.sex)} · 生日 ${formatDate(info.birthDay, 'YYYY-MM-DD')}`
    moodEl.textContent = `幸运值：${luck()} · 疲倦值：${fatigue()}`
    const src = avatar()
    if (portrait.getAttribute('src') !== src) portrait.src = src
    const background = save.selfGoodUseOption.background
    avatarWrap.style.backgroundImage = `url(${background ? goodOf('background', background.id).url : 'pet/info/16.svg'})`
    pdTag.style.display = info.PDiamondLevel ? '' : 'none'
    pdBadge.style.backgroundImage = `url(pet/info/${info.pinkDiamond ? 'u' : 'n'}${info.PDiamondLevel || 1}.svg)`
    pdText.textContent = info.pinkDiamond
      ? `粉钻 Lv.${info.PDiamondLevel || 1} · ${info.PDgrowth}/${info.PDgrowthValue_next}${info.PDiamondYear ? ' · 年费' : ''}`
      : ''
    heartIcon.style.backgroundImage = `url(pet/stateInfo/${info.sweetHeart ? 'h_up' : 'h_down'}.png)`
    heartText.textContent = info.sweetHeartOverTime ? `贴心宝贝 ${formatDate(info.sweetHeartOverTime, 'MM-DD HH:mm')}到期` : '贴心宝贝未开启'
  }

  function syncStats(): void {
    const numbers = snapshot()
    const entries = [...abilityEntries(numbers), ...statusEntries(numbers)]
    readouts.forEach((readout, i) => {
      const entry = entries[i]
      if (!entry) return
      readout.value.textContent = entry.value
      if (!readout.fill || entry.ratio === undefined) return
      const ratio = entry.ratio
      readout.fill.style.width = `${Math.round(ratio * 100)}%`
      readout.fill.className = !readout.graded
        ? 'qp-petinfo-meter-fill'
        : ratio > 0.6
          ? 'qp-petinfo-meter-fill qp-meter-high'
          : ratio > 0.2
            ? 'qp-petinfo-meter-fill'
            : 'qp-petinfo-meter-fill qp-meter-low'
    })
  }

  syncWho()
  syncStats()

  let timer = 0
  sheet = openSheet({
    title: '宠物档案',
    body,
    cardClass: 'qp-page-sheet qp-petinfo-sheet',
    onClose: () => {
      alive = false
      clearInterval(timer)
      if (current === sheet) current = null
    },
  })
  current = sheet
  timer = window.setInterval(() => {
    if (!alive) return
    syncWho()
    syncStats()
  }, 1000)
  // Focus is the shared back stack's job (sheet.ts -> back.ts): opening the sheet
  // makes the window key-targeted and closing the last layer releases it, so a
  // replacement sheet cannot be un-focused by the previous one's deferred close.
  // typeable() re-activates on the rename input itself for the IME.
}

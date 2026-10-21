import GAMES from '../pet/data/games.json'
import { speak } from '../pet/pet'
import { addInfo, earnYb, growthPerMinute, info, runtimeProjectionMode, save, setInfo } from '../pet/store'
import { uiCommands } from '../pet/command-map'
import { commandResultData, dispatchRuntimeCommand } from '../pet/runtime-command'
import { addCount, count } from '../pet/tasks'
import { openBox } from './box'
import './css/games.css'
import { button, div, img } from './dom'
import { floatMood } from './float'
import { playDiudiule } from './diudiule'
import { playSmallGame, SMALL_GAMES } from './smallgame'

let open = false

/** Played minutes a day that earn rewards: 5 元宝, 2 mood and a minute's growth each. */
const DAY_MINUTES = 60

/** Flash-game session token; the host settles it when the game window closes. */
let runtimeGameSession: string | null = null
/** One start request at a time, so a double click cannot open two windows/sessions. */
let runtimeGameOpening = false

window.qqpet.onGamePlayed((minutes) => {
  if (runtimeProjectionMode) {
    // Only a session started by this renderer may be settled; a gamePlayed from
    // an unrelated window (or before the start resolved) is ignored.
    const token = runtimeGameSession
    runtimeGameSession = null
    if (token === null) return
    // The host computes the capped minutes from its own game clock; the local
    // report only tells us the window closed.
    void dispatchRuntimeCommand(uiCommands.gameReward(token)).then((result) => {
      const data = commandResultData<{ minutes: number; yb: number; mood: number }>(result)
      if (data === null || data.minutes <= 0) return
      void floatMood(data.mood)
      speak({ s: `[host]，陪我玩了${data.minutes}分钟小游戏，好开心！获得${data.yb}元宝~`, now: true }, 'speak')
    })
    return
  }
  if (minutes < 1) return
  addCount('GameRound')
  const m = Math.min(Math.floor(minutes), DAY_MINUTES - count('Game'))
  if (m <= 0) return speak({ s: '[host]，今天小游戏玩得够多啦，休息一下眼睛吧~', now: true }, 'speak')
  addCount('Game', m)
  const got = earnYb(5 * m)
  addInfo('growth', +(growthPerMinute() * m).toFixed(8))
  setInfo('mood', Math.min(info.mood + 2 * m, save.petComputedlInfo.moodMax))
  void floatMood(2 * m)
  speak({ s: `[host]，陪我玩了${m}分钟小游戏，好开心！获得${got}元宝~`, now: true }, 'speak')
})

/** Starts a server-owned flash-game session, then opens the legacy SWF window. */
async function startFlashGame(gameId: string): Promise<void> {
  if (runtimeGameOpening) return
  runtimeGameOpening = true
  if (runtimeProjectionMode) {
    const result = await dispatchRuntimeCommand(uiCommands.gameStart(gameId, 'flash'))
    const data = commandResultData<{ sessionToken: string }>(result)
    if (data === null) {
      runtimeGameOpening = false
      return
    }
    runtimeGameSession = data.sessionToken
  }
  runtimeGameOpening = false
  window.qqpet.openGame(gameId)
}

/** Game picker: the desktop games play with the pet, the rest open in their own window. */
export function openGames(): void {
  if (open) return
  open = true
  const cats = [
    {
      name: '陪我玩',
      games: [
        ...SMALL_GAMES.map((g) => ({
          name: g.name,
          icon: g.icon && `pet/quickBar/TickleSystem/${g.icon}00.png`,
          run: () => {
            close()
            open = false
            playSmallGame(g)
          },
        })),
        {
          name: '丢丢乐',
          icon: undefined as string | undefined,
          run: () => {
            close()
            open = false
            playDiudiule()
          },
        },
      ],
    },
    ...GAMES.map((c) => ({
      name: c.name,
      games: c.games.map((g) => ({
        name: g,
        icon: undefined as string | undefined,
        run: () => {
          close()
          open = false
          void startFlashGame(`${c.dir}/${g}.swf`)
        },
      })),
    })),
  ]
  const tabs = div('gameTabs', ...cats.map((c, i) => button('gameTab', () => show(i), c.name)))
  const list = div('gameList')
  function show(i: number): void {
    tabs.querySelectorAll('.gameTab').forEach((t, j) => t.classList.toggle('active', i === j))
    list.replaceChildren(...cats[i].games.map((g) => Object.assign(button('gameItem', g.run, ...(g.icon ? [img('gameItemIcon', g.icon)] : []), g.name), { title: g.name })))
  }
  show(0)
  const close = openBox(div('ui-games', tabs, list), { onClose: () => (open = false) })
}

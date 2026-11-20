// The phone game lobby's pure model: the desktop catalogue (games.json plus the
// six TickleSystem small games and 丢丢乐) grouped into the same seven tabs the
// desktop window shows, flattened into one list, and filtered by a search
// query. No DOM and no commands live here — the sheet in phone-games.ts owns
// those, and the launch itself stays in games.ts so both surfaces share it.
/** One category of the desktop window: a folder of SWFs (games.json). */
export interface PhoneGameSourceCategory {
  name: string
  dir: string
  games: readonly string[]
}

/** The shape of an entry in smallgame.ts's SMALL_GAMES. */
export interface PhoneGameSourceSmall {
  dir: string
  name: string
  icon?: string
}

export type PhoneGameKind = 'small' | 'diudiule' | 'flash'

export interface PhoneGameItem {
  /** Stable identity across redraws and tests. */
  id: string
  name: string
  kind: PhoneGameKind
  categoryId: string
  categoryLabel: string
  /** Tile under pet/quickBar/TickleSystem; '' for the games that have no art. */
  icon: string
  /** SWF folder for a flash game, the small game's own dir otherwise. */
  dir: string
}

export interface PhoneGameCategory {
  id: string
  label: string
  items: PhoneGameItem[]
}

export interface PhoneGamesView {
  categoryId: string
  query: string
}

/** The first chip: the games that play with the pet, exactly like the desktop tab. */
export const PLAY_CATEGORY_ID = 'play'
export const PLAY_CATEGORY_LABEL = '陪我玩'
export const DIUDIULE = '丢丢乐'

/** The icon folder the original quick bar used; the desktop tab reads the same one. */
const TICKLE_ICON = (icon: string): string => `pet/quickBar/TickleSystem/${icon}00.png`

const flashItem = (category: PhoneGameSourceCategory, name: string): PhoneGameItem => ({
  id: `flash:${category.dir}/${name}`,
  name,
  kind: 'flash',
  categoryId: category.dir,
  categoryLabel: category.name,
  icon: '',
  dir: category.dir,
})

const smallItem = (game: PhoneGameSourceSmall): PhoneGameItem => ({
  id: `small:${game.dir}`,
  name: game.name,
  kind: 'small',
  categoryId: PLAY_CATEGORY_ID,
  categoryLabel: PLAY_CATEGORY_LABEL,
  icon: game.icon ? TICKLE_ICON(game.icon) : '',
  dir: game.dir,
})

const diudiuleItem = (): PhoneGameItem => ({
  id: 'diudiule',
  name: DIUDIULE,
  kind: 'diudiule',
  categoryId: PLAY_CATEGORY_ID,
  categoryLabel: PLAY_CATEGORY_LABEL,
  icon: '',
  dir: '',
})

/**
 * The seven chips, in desktop order: 陪我玩 (the six small games and 丢丢乐)
 * followed by every games.json folder.
 */
export function buildPhoneGames(
  games: readonly PhoneGameSourceCategory[],
  smalls: readonly PhoneGameSourceSmall[],
): PhoneGameCategory[] {
  const play: PhoneGameCategory = {
    id: PLAY_CATEGORY_ID,
    label: PLAY_CATEGORY_LABEL,
    items: [...smalls.map(smallItem), diudiuleItem()],
  }
  return [
    play,
    ...games.map((category) => ({
      id: category.dir,
      label: category.name,
      items: category.games.map((name) => flashItem(category, name)),
    })),
  ]
}

/** Every game once, in chip order then desktop order: what a search walks. */
export function flattenGames(categories: readonly PhoneGameCategory[]): PhoneGameItem[] {
  return categories.flatMap((category) => category.items)
}

/** The chip the view points at; an unknown id falls back to the first chip. */
export function categoryOf(categories: readonly PhoneGameCategory[], id: string): PhoneGameCategory {
  const found = categories.find((category) => category.id === id)
  if (found) return found
  return categories[0] ?? { id: '', label: '', items: [] }
}

/** A fresh view; the lobby opens on 陪我玩 with no query. */
export function createGamesView(categories: readonly PhoneGameCategory[]): PhoneGamesView {
  return { categoryId: categories[0]?.id ?? '', query: '' }
}

/**
 * Name or category, case-insensitive, blanks ignored. Matching the category
 * name is what lets 「冒险岛」 find 1起航…8宝藏, whose names never say it.
 */
export function filterGames(items: readonly PhoneGameItem[], query: string): PhoneGameItem[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return [...items]
  return items.filter((item) =>
    item.name.toLowerCase().includes(needle) || item.categoryLabel.toLowerCase().includes(needle),
  )
}

/**
 * What the list shows: the selected chip normally, the whole catalogue while a
 * query is active — searching from 陪我玩 must still find a 企鹅 flash game.
 */
export function visibleGames(categories: readonly PhoneGameCategory[], view: PhoneGamesView): PhoneGameItem[] {
  if (view.query.trim().length > 0) return filterGames(flattenGames(categories), view.query)
  return [...categoryOf(categories, view.categoryId).items]
}

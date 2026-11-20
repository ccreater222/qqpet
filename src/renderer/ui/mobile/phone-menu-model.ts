// The phone menu's pure model: a menu tree becomes ordered sections (互动 /
// 工具 / 养成 / 设置 / 其他, danger last) and a flat list of rows whose children
// show inline. No DOM or store imports, so scripts/tests can import it directly
// and the rendering layer stays a thin projection of this state.

export type MenuGroup = 'interact' | 'tools' | 'care' | 'settings' | 'other'
export type MenuSectionId = MenuGroup | 'danger'

export interface PhoneMenuItem {
  label: string
  run?: () => void
  children?: PhoneMenuItem[]
  /** Shows a check mark. */
  on?: boolean
  title?: string
  /** Where the item belongs; unlabelled items fall into 其他. */
  group?: MenuGroup
  /** Destructive actions are red and always shown after the normal sections. */
  danger?: boolean
}

export interface MenuSection<T extends PhoneMenuItem = PhoneMenuItem> {
  id: MenuSectionId
  title: string
  items: T[]
}

export interface MenuView {
  /** Keys of expanded parent rows (see menuRowKey). */
  readonly expanded: readonly string[]
}

export interface MenuRow<T extends PhoneMenuItem = PhoneMenuItem> {
  key: string
  section: MenuSectionId
  item: T
  depth: 0 | 1
  expanded: boolean
}

export const MENU_GROUP_ORDER: readonly MenuGroup[] = ['interact', 'tools', 'care', 'settings', 'other']

export const MENU_GROUP_TITLES: Record<MenuGroup, string> = {
  interact: '互动',
  tools: '工具',
  care: '养成',
  settings: '设置',
  other: '其他',
}

export const DANGER_SECTION_TITLE = '危险操作'

const GROUP_IDS = new Set<string>(MENU_GROUP_ORDER)

export function isDangerous(item: Pick<PhoneMenuItem, 'danger'>): boolean {
  return item.danger === true
}

/** A parent row key; stable while the menu tree is unchanged. */
export function menuRowKey(section: MenuSectionId, index: number): string {
  return `${section}:${index}`
}

/** Groups items in section order, hoisting danger items into a final section. */
export function groupMenuItems<T extends PhoneMenuItem>(items: readonly T[]): MenuSection<T>[] {
  const buckets = new Map<MenuSectionId, T[]>()
  for (const item of items) {
    const id: MenuSectionId = isDangerous(item)
      ? 'danger'
      : item.group !== undefined && GROUP_IDS.has(item.group)
        ? item.group
        : 'other'
    const bucket = buckets.get(id)
    if (bucket) bucket.push(item)
    else buckets.set(id, [item])
  }
  const sections: MenuSection<T>[] = []
  for (const id of MENU_GROUP_ORDER) {
    const bucket = buckets.get(id)
    if (bucket?.length) sections.push({ id, title: MENU_GROUP_TITLES[id], items: bucket })
  }
  const danger = buckets.get('danger')
  if (danger?.length) sections.push({ id: 'danger', title: DANGER_SECTION_TITLE, items: danger })
  return sections
}

/** Every entry in the tree, children included; the menu must never lose one. */
export function countMenuItems(items: readonly PhoneMenuItem[]): number {
  let n = 0
  for (const item of items) {
    n += 1 + countMenuItems(item.children ?? [])
  }
  return n
}

export function createMenuView(): MenuView {
  return { expanded: [] }
}

export function isRowExpanded(view: MenuView, key: string): boolean {
  return view.expanded.includes(key)
}

/** Opens or closes one parent row without touching the others. */
export function toggleMenuRow(view: MenuView, key: string): MenuView {
  return {
    expanded: isRowExpanded(view, key) ? view.expanded.filter((entry) => entry !== key) : [...view.expanded, key],
  }
}

/** Top-level rows in order, with the children of expanded rows immediately below. */
export function menuRows<T extends PhoneMenuItem>(sections: readonly MenuSection<T>[], view: MenuView): MenuRow<T>[] {
  const rows: MenuRow<T>[] = []
  for (const section of sections) {
    section.items.forEach((item, index) => {
      const key = menuRowKey(section.id, index)
      const expanded = isRowExpanded(view, key)
      rows.push({ key, section: section.id, item, depth: 0, expanded })
      if (expanded) {
        ;(item.children as T[] | undefined)?.forEach((child, childIndex) => {
          rows.push({ key: `${key}:${childIndex}`, section: section.id, item: child, depth: 1, expanded: false })
        })
      }
    })
  }
  return rows
}

export interface RuntimeMenuItem {
  label: string
  run: () => void
}

/**
 * C6a exposes no unconverted canonical action through the pet menu. With a pet
 * only quitting is safe; without one, adoption is routed through pet.adopt.
 */
export function runtimeMenuItems(hasPet: boolean, adopt: () => void, leave: () => void): RuntimeMenuItem[] {
  if (hasPet) return [{ label: '退出宠物', run: leave }]
  return [
    { label: '选择宠物', run: adopt },
    { label: '退出宠物', run: leave },
  ]
}

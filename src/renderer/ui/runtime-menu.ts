export interface RuntimeMenuItem {
  label: string
  run?: () => void
  children?: RuntimeMenuItem[]
  on?: boolean
  title?: string
}

export interface RuntimeMenuActions {
  adopt: () => void
  leave: () => void
  openState: () => void
  openShop: () => void
  openGoods: (type: 'food' | 'clean' | 'medicine') => void
  openPetInfo: () => void
  openSetup: () => void
  openFarm: () => void
  openFishing: () => void
  openGames: () => void
  readopt: () => void
  bury: () => void
  togglePaused: () => void
  paused: boolean
  dead: boolean
  buried: boolean
}

/**
 * C7 runtime navigation. Only panels converted to commands/projections are
 * exposed: lifecycle, inventory, jobs/study/travel, tasks/sign-in/mail, games,
 * diudiule and fishing. Farm, island, LAN social and community stay hidden
 * until their conversion lands.
 */
export function runtimeMenuItems(hasPet: boolean, actions: RuntimeMenuActions): RuntimeMenuItem[] {
  const leave = { label: '退出宠物', run: actions.leave }
  if (hasPet === false) return [{ label: '选择宠物', run: actions.adopt }, leave]
  if (actions.buried) return [{ label: '重新领养宠物', title: '清空当前宠物并重新开始', run: actions.readopt }, leave]
  const help = {
    label: '设置帮助',
    children: [
      { label: '宠物资料', run: actions.openPetInfo },
      { label: '系统设置', run: actions.openSetup },
    ],
  }
  const state = { label: '宠物状态', run: actions.openState }
  if (actions.dead) {
    return [{ label: '打开商城', run: actions.openShop }, help, state, { label: '埋葬宠物', run: actions.bury }, leave]
  }
  return [
    { label: '打开商城', run: actions.openShop },
    {
      label: '喂养宠物',
      children: [
        { label: '喂养', run: () => actions.openGoods('food') },
        { label: '清洗', run: () => actions.openGoods('clean') },
        { label: '吃药', run: () => actions.openGoods('medicine') },
      ],
    },
    help,
    state,
    {
      label: '活动',
      children: [
        { label: '池塘', run: actions.openFishing },
        { label: '农场', run: actions.openFarm },
        { label: '游戏', run: actions.openGames },
      ],
    },
    { label: actions.paused ? '开始成长' : '停止成长', on: actions.paused, run: actions.togglePaused },
    { label: '重新领养宠物', title: '清空当前宠物并重新开始', run: actions.readopt },
    leave,
  ]
}

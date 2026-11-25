import type { Good } from '../pet/data/goods'
import { info } from '../pet/store'
import { festivalShareCardSvg, type FestivalShareInput } from '../../shared/pet-runtime/festival'
import { windowView } from './window-view'

/** 宠物名缺失时的兜底称呼，和活动文案里的自称一致。 */
const DEFAULT_PET_NAME = '企鹅'

/**
 * 「晒餐盒」分享卡：把本次领到的食物/玩具拼成一张 600x800 的 SVG，
 * 用 windowView 的大图预览展示，长按/右键即可保存。纯本地生成，不接社交平台。
 */
export function openFestivalShareCard(line: string, goods: readonly Good[]): void {
  const petName = info.name.trim() || DEFAULT_PET_NAME
  const input: FestivalShareInput = {
    petName,
    line,
    goods: goods.map((good) => ({
      id: good.id,
      name: good.name,
      type: good.type,
      url: good.url,
      num: good.num,
    })),
  }
  const svg = festivalShareCardSvg(input)
  windowView({
    title: '疯狂星期四晒餐盒',
    msg: '长按/右键保存这张分享图，V我50！',
    image: { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, alt: '疯狂星期四晒餐盒分享图' },
  })
}

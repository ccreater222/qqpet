import type { Good } from '../pet/data/goods'
import './css/result.css'
import { button, div, img } from './dom'
import { openFestivalShareCard } from './share-card'

export interface ResultOptions {
  /** 疯狂星期四：餐盒开箱演出与「晒餐盒」入口。 */
  festival?: boolean
  /** 分享卡/结果面板上的一句话；默认「V我50」。 */
  shareText?: string
}

const DEFAULT_SHARE_TEXT = 'V我50！'

/** shared festival.ts 的 active 活动邮件 key 前缀（稳定内部键）。 */
const FESTIVAL_ACTIVE_MAIL_PREFIX = 'crazy-thursday-'
/** 预告邮件 key 前缀是 active 前缀的更长变体，先排除它。 */
const FESTIVAL_PREVIEW_MAIL_PREFIX = 'crazy-thursday-preview-'

/** 只有 shared 运行时投递的 active 活动邮件才走晒餐盒；预告邮件与普通邮件保持原样。 */
export function isFestivalActiveMailKey(key: string | undefined): boolean {
  return typeof key === 'string' && key.startsWith(FESTIVAL_ACTIVE_MAIL_PREFIX) && !key.startsWith(FESTIVAL_PREVIEW_MAIL_PREFIX)
}

/** The task and sign-in panels' overlay over `host`: the goods just received, or `msg` when there are none. */
export function showResult(host: HTMLElement, goods: Good[], msg = '', options: ResultOptions = {}): void {
  const festival = options.festival === true
  const goodsBody = div(
    'grb_mgs fcw',
    ' 你领取了 ',
    ...goods.map((g) =>
      div(
        'grb_goods fcC p8',
        Object.assign(img('e_goodImgs', g.url), { title: `${g.outOfPrint ? '绝版：' : ''}${g.name}*${g.num}` }),
        div('pt4', `${g.name}*${g.num}`),
      ),
    ),
  )
  if (festival && options.shareText) goodsBody.append(div('festival-share-text', options.shareText))
  const body = goods.length ? goodsBody : div('grb_mgs', msg)
  const actions: HTMLElement[] = []
  if (festival && goods.length) {
    actions.push(
      button(
        'but_small fcc mt8 festival-share',
        () => openFestivalShareCard(options.shareText ?? DEFAULT_SHARE_TEXT, goods),
        '晒餐盒',
      ),
    )
  }
  actions.push(button('but_small fcc mt8', () => mark.remove(), '确定'))
  const mark = div(
    festival ? 'markFull fcc festival-result' : 'markFull fcc',
    div('getResult', div('getResultBorder fcC', body, ...actions)),
  )
  host.append(mark)
}

// 手机菜单顶部「宠物舞台」的纯几何模型：舞台盒只由 slot 矩形和 sheet body 的
// 可视区决定，不碰 DOM、不读写宠物位置或存档，所以 scripts/tests 可以直接单测。
//
// 为什么单独一层：舞台随列表滚动，宠物盒要同时表达「画在哪」和「滚出可视区后被裁
// 掉多少」。把这两件事写成纯函数后，main.ts 只负责把结果写进 #pet 的样式，滚动
// 监听只看差值；数值单位一律是 dp（手机模式下 1 dp = 1 CSS px），对外只吐整数。

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/** 可视区（sheet 的可滚动 body）上下边界。 */
export interface Viewport {
  top: number
  bottom: number
}

export interface PetStageBox {
  left: number
  top: number
  size: number
  /** 舞台盒顶部被 body 可视区裁掉的 dp 数。 */
  clipTop: number
  /** 舞台盒底部被 body 可视区裁掉的 dp 数。 */
  clipBottom: number
}

/** 宠物盒底边与 slot 底边的留白，避免贴着卡片分隔线。 */
const BOTTOM_PAD = 8
/** 宠物盒默认上限：再大就会把菜单第一屏挤没。 */
const MAX_SIZE = 300

/**
 * 计算舞台里的宠物盒；返回 null 表示舞台完全滚出可视区，宠物应隐藏。
 * 尺寸按 slot 宽度定而不是高度：SWF 里的角色美术只占盒子底部约一半，按高度算会显得小。
 * 盒子允许向上溢出 slot（角色上方的透明边距），真正可见的部分由 view 的裁剪兜住。
 * `maxSize` 只给测试/特殊宿主用，正常调用走 300dp 上限。
 */
export function petStageBox(slot: Rect, view: Viewport, maxSize: number = MAX_SIZE): PetStageBox | null {
  const size = Math.floor(Math.min(slot.width * 0.82, maxSize))
  if (size <= 0) return null
  // 水平居中、底对齐（留 8dp），全部取整到 dp，避免 #pet 落在半像素上。
  const left = Math.round(slot.left + (slot.width - size) / 2)
  const top = Math.round(slot.top + slot.height - BOTTOM_PAD - size)
  const clipTop = Math.max(0, Math.round(view.top - top))
  const clipBottom = Math.max(0, Math.round(top + size - view.bottom))
  // 整只宠物都在可视区外时返回 null：调用方据此隐藏视觉层，而不是上报一个空盒子。
  if (clipTop >= size || clipBottom >= size) return null
  return { left, top, size, clipTop, clipBottom }
}

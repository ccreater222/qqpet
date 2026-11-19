import { parseGood, type Good } from './data/goods'

export interface PreviewTask {
  reroll?: number
  good?: string[]
}

/**
 * The goods a task advertises before it is claimed. In projection (server) mode
 * the authoritative host rolls reroll goods at claim time, so the renderer must
 * show only the fixed rewards instead of drawing a different set locally.
 */
export function previewTaskGoods(
  task: PreviewTask,
  options: { projectionMode: boolean; loot: (count: number) => Good[] },
): Good[] {
  const fixed = (task.good ?? []).map(parseGood)
  if (options.projectionMode) return fixed
  const random = task.reroll ? options.loot(task.reroll) : []
  return [...random, ...fixed]
}

import type { CommandError, CommandKey, CommandResult, PetCommand } from '../../shared/sync/protocol'
import { goodOf, type Good } from './data/goods'

export function runtimeCommandMode(): boolean {
  return window.__qqpetRuntimeV2 === true
}

const ERROR_TEXT: Partial<Record<CommandError['code'], string>> = {
  invalid_payload: '操作参数无效',
  op_id_conflict: '操作正在处理中，请稍后重试',
  no_pet: '还没有宠物哦',
  pet_dead: '宠物已经死亡',
  paused: '宠物处于暂停成长状态',
  busy: '宠物正忙，请稍后再试',
  insufficient_funds: '元宝不足',
  insufficient_item: '背包里的物品不足',
  not_available: '当前无法进行这个操作',
  wrong_phase: '当前状态不能进行这个操作',
  already_claimed: '已经领取过了',
  cooldown: '还没到时间，请稍后再试',
  unauthorized: '没有权限执行这个操作',
  offline: '当前离线',
  server_catching_up: '宠物数据正在同步，请稍后再试',
  authority_not_active: '宠物数据尚未就绪',
  authority_fork_risk: '数据权威状态异常，请先处理存档冲突',
  authority_reset_required: '需要重新同步宠物数据',
  anchor_out_of_bounds: '存档时间范围无效',
  internal: '内部错误，请稍后重试',
}

export function commandErrorText(error: CommandError): string {
  return ERROR_TEXT[error.code] ?? error.message ?? '操作失败'
}

function emitCommandError(error: CommandError): void {
  window.dispatchEvent(new CustomEvent('qqpet-command-error', {
    detail: { code: error.code, message: commandErrorText(error) },
  }))
}

export function commandSucceeded(result: CommandResult | null): boolean {
  return result !== null && (result.status === 'applied' || (result.status === 'duplicate' && result.original === 'applied'))
}

/**
 * Dispatches a semantic command in projection mode. Returns null in legacy mode
 * so callers keep their legacy implementation untouched.
 */
export async function dispatchRuntimeCommand<K extends CommandKey>(
  command: Extract<PetCommand, { type: K }>,
  options: { opId?: string } = {},
): Promise<CommandResult<K> | null> {
  if (runtimeCommandMode() === false) return null
  try {
    const result = await window.qqpet.command(command, options)
    if (result.status === 'rejected') emitCommandError(result.error)
    else if (result.status === 'duplicate' && result.error !== undefined) emitCommandError(result.error)
    return result
  } catch (error) {
    window.dispatchEvent(new CustomEvent('qqpet-command-error', {
      detail: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
    }))
    return null
  }
}

/** Presentation helper: typed command result goods become real Good entries for result dialogs. */
export function commandResultGoods(result: CommandResult | null): Good[] {
  if (commandSucceeded(result) === false || result === null || result.status === 'rejected') return []
  const payload = result.result
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return []
  const goods = (payload as Record<string, unknown>).goods
  if (Array.isArray(goods) === false) return []
  const parsed: Good[] = []
  for (const entry of goods) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const type = record.type
    const id = record.id
    if (typeof type !== 'string' || typeof id !== 'string') continue
    try {
      const good = goodOf(type as Good['type'], id)
      // goodOf spreads an unknown table row into an empty object; never present
      // a fabricated reward for an id the content pack does not know.
      if (good.id !== id) continue
      const num = typeof record.num === 'number' && Number.isFinite(record.num) ? record.num : good.num
      parsed.push({ ...good, num })
    } catch {
      // Presentation-only fallback: unknown reward ids are ignored, not guessed.
    }
  }
  return parsed
}

/** Typed presentation payload from an applied command, never used as canonical state. */
export function commandResultData<T>(result: CommandResult | null): T | null {
  if (commandSucceeded(result) === false || result === null || result.status === 'rejected') return null
  const data = result.result
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  return data as T
}

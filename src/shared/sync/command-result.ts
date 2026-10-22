import type { CommandError, CommandKey, CommandResult } from './protocol'

/** The effective outcome of a command, collapsing an idempotent duplicate to its stored original. */
export function commandResultOutcome<K extends CommandKey>(
  result: CommandResult<K>,
): 'applied' | 'rejected' {
  if (result.status === 'rejected') return 'rejected'
  if (result.status === 'duplicate') return result.original
  return 'applied'
}

export function commandResultSucceeded<K extends CommandKey>(result: CommandResult<K>): boolean {
  return commandResultOutcome(result) === 'applied'
}

/**
 * Returns the stored/rejection error. A duplicate rejected result carries the
 * original error; malformed injected transports still get a fail-closed error.
 */
export function commandResultError<K extends CommandKey>(result: CommandResult<K>): CommandError | null {
  if (commandResultOutcome(result) === 'applied') return null
  if (result.status === 'rejected') return result.error
  if (result.status === 'duplicate') {
    return result.error ?? {
      code: 'internal',
      message: 'the server rejected the original command but returned no error',
      refreshProjection: true,
    }
  }
  return null
}

/** Stored result data for applied or duplicate-applied commands only. */
export function commandResultData<K extends CommandKey>(result: CommandResult<K>): unknown {
  if (commandResultSucceeded(result) === false) return undefined
  return 'result' in result ? result.result : undefined
}

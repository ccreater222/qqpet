import { type LocalRepositoryCapability } from './local-repository'

/**
 * C7 local cutover: the shared local v2 runtime is the default writer on a
 * renderer-capable host. `QQPET_LOCAL_V2_ROLLBACK=1` restores the legacy
 * writer for the migration window.
 */
export const LOCAL_V2_ROLLBACK_ENV_FLAG = 'QQPET_LOCAL_V2_ROLLBACK'

/** Explicit escape hatch back to the legacy renderer writer after cutover. */
export function desktopRuntimeRollbackRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LOCAL_V2_ROLLBACK_ENV_FLAG] === '1'
}

export function desktopRendererRuntimeCapability(env: NodeJS.ProcessEnv = process.env): LocalRepositoryCapability {
  if (desktopRuntimeRollbackRequested(env)) {
    return { flagEnabled: true, canActivate: false, activation: 'default-local-v2', reason: 'rollback_flag' }
  }
  return { flagEnabled: true, canActivate: true, activation: 'default-local-v2' }
}

export function desktopRendererRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return desktopRendererRuntimeCapability(env).canActivate
}

export const LOCAL_V2_DOCUMENT_NAME = 'save.v2.json'

/** Legacy mode must never write next to an existing v2 authority document. */
export function legacyStartupBlockedByV2(v2DocumentExists: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return v2DocumentExists && desktopRendererRuntimeEnabled(env) === false
}

export type DesktopStartupAuthority = 'runtime' | 'legacy' | 'blocked'

/** Chooses exactly one desktop writer before either loader touches disk. */
export function desktopStartupAuthority(
  v2DocumentExists: boolean,
  env: NodeJS.ProcessEnv = process.env,
): DesktopStartupAuthority {
  if (desktopRendererRuntimeEnabled(env)) return 'runtime'
  return v2DocumentExists ? 'blocked' : 'legacy'
}

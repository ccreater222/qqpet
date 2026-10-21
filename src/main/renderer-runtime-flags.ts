import {
  LOCAL_V2_ACTIVE_ENV_FLAG,
  localRepositoryCapability,
  type LocalRepositoryCapability,
} from './local-repository'

/**
 * C6 requires three explicit assertions before the renderer may replace the
 * legacy writer: the local repository dev flag, the C6 activation flag, and a
 * renderer-capable host. No default environment path reaches this function
 * with `canActivate: true`.
 */
export const LOCAL_V2_ROLLBACK_ENV_FLAG = 'QQPET_LOCAL_V2_ROLLBACK'

/** Explicit escape hatch back to the legacy renderer writer after cutover. */
export function desktopRuntimeRollbackRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LOCAL_V2_ROLLBACK_ENV_FLAG] === '1'
}

export function desktopRendererRuntimeCapability(env: NodeJS.ProcessEnv = process.env): LocalRepositoryCapability {
  if (desktopRuntimeRollbackRequested(env)) {
    return { flagEnabled: true, canActivate: false, activation: 'c6-renderer-capability', reason: 'rollback_flag' }
  }
  const c6RendererCapability = env[LOCAL_V2_ACTIVE_ENV_FLAG] === '1'
  return localRepositoryCapability(env, false, c6RendererCapability)
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

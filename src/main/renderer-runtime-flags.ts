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
export function desktopRendererRuntimeCapability(env: NodeJS.ProcessEnv = process.env): LocalRepositoryCapability {
  const c6RendererCapability = env[LOCAL_V2_ACTIVE_ENV_FLAG] === '1'
  return localRepositoryCapability(env, false, c6RendererCapability)
}

export function desktopRendererRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return desktopRendererRuntimeCapability(env).canActivate
}

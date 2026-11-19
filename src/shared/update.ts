import { withTimeoutSignal } from './compat'
import type { Fetch, Release } from './ipc'
import { clientUrl } from './upstream'

interface Reply {
  version?: unknown
  url?: unknown
}

/**
 * The newest release qqpet-server publishes at `/v1/client/release` (`{version, url}`, the
 * release page). Rejects with `upstream_not_configured` when `base` is unusable, so a
 * manual update check can say so instead of reaching out to a third party.
 */
export async function latestRelease(fetch: Fetch, base: string | null | undefined): Promise<Release> {
  const url = clientUrl(base, '/v1/client/release')
  return withTimeoutSignal(20_000, async (signal) => {
    const response = await fetch(url, { signal })
    if (response.ok === false) throw new Error(`${response.status} ${(await response.text()).slice(0, 100)}`)
    const reply = (await response.json()) as Reply
    if (typeof reply?.version !== 'string' || reply.version === '') throw new Error('release_invalid: version')
    if (typeof reply.url !== 'string' || /^https?:\/\//.test(reply.url) === false) throw new Error('release_invalid: url')
    return { version: reply.version.replace(/^v/, ''), url: reply.url }
  })
}

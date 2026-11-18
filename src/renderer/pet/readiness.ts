import type { RendererRepositoryStatus } from '../../shared/renderer-api'

export interface RuntimeStatusSource {
  onSyncStatus(listener: (status: RendererRepositoryStatus) => void): void
  getStatus(): RendererRepositoryStatus | Promise<RendererRepositoryStatus>
}

export interface ReadinessBannerElement {
  hidden: boolean | string
  textContent: string | null
}

/**
 * The user-facing readiness line for the runtime repository. Commands are
 * rejected by the host until the repository is ready, so the renderer only
 * needs to explain the wait and avoid pretending the UI is writable.
 */
export function runtimeReadinessNotice(status: RendererRepositoryStatus | null | undefined): string | null {
  if (status === null || status === undefined) return null
  if (status.catchingUp === true || status.connection === 'catching_up') return '宠物数据同步中，请稍候…'
  if (status.authorityState === 'handoff_pending') return '宠物数据正在交接，请稍候…'
  if (status.readOnly === true || status.connection === 'offline' || status.state === 'read_only') return '宠物数据暂时只读，同步完成后可继续操作'
  return null
}

export function runtimeReady(status: RendererRepositoryStatus | null | undefined): boolean {
  return runtimeReadinessNotice(status) === null
}

/**
 * Keeps readiness visible across the repository lifecycle. Status changes emit
 * before this module subscribes are recovered with a post-subscribe snapshot;
 * replacing the IPC listener replays that snapshot as well.
 */
export class RuntimeReadinessBanner {
  private readonly element: ReadinessBannerElement
  private active = true

  constructor(element: ReadinessBannerElement, source: RuntimeStatusSource) {
    this.element = element
    source.onSyncStatus((status) => {
      if (this.active) this.apply(status)
    })
    void Promise.resolve(source.getStatus()).then(
      (status) => {
        if (this.active) this.apply(status)
      },
      (error: unknown) => console.error('QQPet runtime status snapshot failed:', error),
    )
  }

  dispose(): void {
    this.active = false
  }

  private apply(status: RendererRepositoryStatus): void {
    const notice = runtimeReadinessNotice(status)
    this.element.hidden = notice === null
    this.element.textContent = notice ?? ''
  }
}

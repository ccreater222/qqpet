import type { SessionCoverageInterval } from './types'

export interface SessionActivity {
  activeClientCount: number
  sessionActive: boolean
}

function assertWall(value: number, name: string): void {
  if (Number.isSafeInteger(value) === false || value < 0) throw new Error(name + ' must be a non-negative safe integer')
}

/**
 * Derives the number of authenticated clients whose persisted coverage
 * overlaps the half-open wall interval [fromWallMs, toWallMs).
 */
export function sessionActivityForInterval(
  coverage: readonly SessionCoverageInterval[],
  fromWallMs: number,
  toWallMs: number,
): SessionActivity {
  assertWall(fromWallMs, 'fromWallMs')
  assertWall(toWallMs, 'toWallMs')
  if (toWallMs <= fromWallMs) throw new Error('toWallMs must be greater than fromWallMs')
  let activeClientCount = 0
  for (const interval of coverage) {
    assertWall(interval.connectedAtWallMs, 'connectedAtWallMs')
    assertWall(interval.lastHeartbeatWallMs, 'lastHeartbeatWallMs')
    if (interval.disconnectedAtWallMs !== undefined) {
      assertWall(interval.disconnectedAtWallMs, 'disconnectedAtWallMs')
      if (interval.disconnectedAtWallMs <= fromWallMs) continue
    }
    if (interval.connectedAtWallMs >= toWallMs) continue
    activeClientCount++
  }
  return { activeClientCount, sessionActive: activeClientCount > 0 }
}

export function activeClientCountAt(coverage: readonly SessionCoverageInterval[], wallMs: number): number {
  assertWall(wallMs, 'wallMs')
  let count = 0
  for (const interval of coverage) {
    assertWall(interval.connectedAtWallMs, 'connectedAtWallMs')
    if (interval.connectedAtWallMs > wallMs) continue
    if (interval.disconnectedAtWallMs !== undefined) {
      assertWall(interval.disconnectedAtWallMs, 'disconnectedAtWallMs')
      if (interval.disconnectedAtWallMs <= wallMs) continue
    }
    count++
  }
  return count
}

/**
 * Pure presentation cues for projection-mode domain events. These functions do
 * not read the store, play animations, or write state; pet.ts owns the effect
 * and the event stream remains the source of truth.
 */

export interface SpeechCue {
  c: string
  s: string
  action: string
}

/** Work/study/travel completion line; cancelled batches use the original mood-empty lines when kinds are present. */
export function activityCompletedCue(payload: Record<string, unknown>): SpeechCue | null {
  if (payload.cancelled === true) {
    const kinds = Array.isArray(payload.kinds) ? payload.kinds : []
    if (kinds.includes('work')) return { c: 'state', s: 'stopWorkFoMood0', action: 'speak' }
    if (kinds.includes('study')) return { c: 'state', s: 'stopStudyFoMood0', action: 'speak' }
    if (kinds.includes('travel')) return { c: 'state', s: 'overTripUpFoMood0', action: 'speak' }
    return null
  }
  const kind = payload.kind
  if (kind === 'work') return { c: 'state', s: 'overWork', action: 'speak' }
  if (kind === 'study') {
    const early = payload.early === true
    return { c: 'state', s: early ? 'cententStudy' : 'overStudy', action: 'speak' }
  }
  if (kind === 'travel') {
    return { c: 'state', s: payload.early === true ? 'overTripUp' : 'overTrip', action: 'speak' }
  }
  return null
}

/** Level-up cue. Levels 5 and 10 use the original first-growth clips. */
export function levelChangedCue(payload: Record<string, unknown>): SpeechCue | null {
  const previous = Number(payload.previousLevel)
  const level = Number(payload.level)
  if (Number.isFinite(previous) === false || Number.isFinite(level) === false || level <= previous) return null
  const first = (level === 5 && previous === 4) || (level === 10 && previous === 9)
  return first
    ? { c: `first${level === 5 ? 1 : 2}`, s: '', action: 'first' }
    : { c: 'levUp', s: '', action: 'levUp' }
}

export interface AchievementCue {
  title: string
  msg: string
  src: string
  name: string
}

/** The only achievement emitted by the shared runtime today. */
export function achievementCue(payload: Record<string, unknown>): AchievementCue | null {
  if (payload.achievement !== 'fish-master') return null
  return { title: '逗逗我~~', msg: '养鱼大师成就达成~~', src: 'pet/achievement/yyds.svg', name: '养鱼大师' }
}

/** One bubble for a batch of mail arrivals; callers debounce and pass the latest title. */
export function mailNoticeText(title: string): string {
  const clean = title.trim()
  return clean.length === 0
    ? '[host]，邮箱里来了新邮件，快去看看吧~'
    : `[host]，邮箱里来了新邮件：${clean}，快去看看吧~`
}

export interface UnreadMailSummary {
  mailId: string
  title: string
  count: number
  latest: number
}

type MailLike = { d?: number; l?: string; r?: boolean; e?: unknown }

/**
 * The newest unread mail not covered by the local announcement watermark.
 * `readMails()` returns both live and tombstoned entries; only live, unclaimed
 * entries count. The watermark is presentation-only and never touches save.
 */
export function unreadMailSummary(
  mails: Record<string, MailLike>,
  announcedThrough = 0,
): UnreadMailSummary | null {
  const unread = Object.entries(mails)
    .filter(([, mail]) => mail.e === undefined && mail.r !== true && typeof mail.d === 'number' && mail.d > announcedThrough)
    .sort((left, right) => (right[1].d ?? 0) - (left[1].d ?? 0))
  if (unread.length === 0) return null
  const [mailId, mail] = unread[0]
  return {
    mailId,
    title: typeof mail.l === 'string' ? mail.l : '',
    count: unread.length,
    latest: mail.d ?? announcedThrough,
  }
}

export function unreadMailNoticeText(summary: UnreadMailSummary): string {
  return summary.count > 1
    ? `[host]，邮箱里有${summary.count}封没看的邮件，快去看看吧~`
    : mailNoticeText(summary.title)
}

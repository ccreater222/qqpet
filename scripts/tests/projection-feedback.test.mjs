import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activityCompletedCue,
  achievementCue,
  levelChangedCue,
  mailNoticeText,
  unreadMailNoticeText,
  unreadMailSummary,
} from '../../src/renderer/pet/projection-feedback.ts'

test('activity completion cues match the original lines and skip cancelled exams', () => {
  assert.deepEqual(activityCompletedCue({ kind: 'work' }), { c: 'state', s: 'overWork', action: 'speak' })
  assert.deepEqual(activityCompletedCue({ kind: 'study', early: false }), { c: 'state', s: 'overStudy', action: 'speak' })
  assert.deepEqual(activityCompletedCue({ kind: 'study', early: true }), { c: 'state', s: 'cententStudy', action: 'speak' })
  assert.deepEqual(activityCompletedCue({ kind: 'travel', early: false }), { c: 'state', s: 'overTrip', action: 'speak' })
  assert.deepEqual(activityCompletedCue({ kind: 'travel', early: true }), { c: 'state', s: 'overTripUp', action: 'speak' })
  assert.equal(activityCompletedCue({ kind: 'work', cancelled: true }), null)
  assert.equal(activityCompletedCue({ kind: 'exam', passed: true }), null)
  assert.deepEqual(activityCompletedCue({ kind: 'all', cancelled: true, reason: 'mood_empty', kinds: ['work'] }), { c: 'state', s: 'stopWorkFoMood0', action: 'speak' })
  assert.equal(activityCompletedCue({ kind: 'all', cancelled: true, reason: 'mood_empty', kinds: [] }), null)
})

test('level cues use the first-growth clips only at levels 5 and 10', () => {
  assert.deepEqual(levelChangedCue({ previousLevel: 4, level: 5 }), { c: 'first1', s: '', action: 'first' })
  assert.deepEqual(levelChangedCue({ previousLevel: 9, level: 10 }), { c: 'first2', s: '', action: 'first' })
  assert.deepEqual(levelChangedCue({ previousLevel: 7, level: 8 }), { c: 'levUp', s: '', action: 'levUp' })
  assert.equal(levelChangedCue({ previousLevel: 8, level: 8 }), null)
  assert.equal(levelChangedCue({ previousLevel: 9, level: 8 }), null)
})

test('achievement cues whitelist the emitted fish-master event and ignore unknown ones', () => {
  assert.deepEqual(achievementCue({ achievement: 'fish-master', total: 2 }), {
    title: '逗逗我~~', msg: '养鱼大师成就达成~~', src: 'pet/achievement/yyds.svg', name: '养鱼大师',
  })
  assert.equal(achievementCue({ achievement: 'unknown', total: 1 }), null)
})

test('mail notices keep the title but still work without one', () => {
  assert.match(mailNoticeText('生日快乐！'), /生日快乐/)
  assert.doesNotMatch(mailNoticeText('   '), /：/)
})

test('startup unread mail picks the newest live unclaimed entry above the watermark', () => {
  const mails = {
    '10': { d: 10, l: '旧邮件' },
    '20': { d: 20, l: '生日邮件', r: false },
    '30': { d: 30, l: '已领', r: true },
    '40': { d: 40, e: true },
  }
  assert.deepEqual(unreadMailSummary(mails, 0), { mailId: '20', title: '生日邮件', count: 2, latest: 20 })
  assert.deepEqual(unreadMailSummary(mails, 10), { mailId: '20', title: '生日邮件', count: 1, latest: 20 })
  assert.equal(unreadMailSummary(mails, 20), null)
  assert.equal(unreadMailSummary({}, 0), null)
  assert.match(unreadMailNoticeText({ mailId: '20', title: '生日邮件', count: 1, latest: 20 }), /生日邮件/)
  assert.match(unreadMailNoticeText({ mailId: '20', title: '', count: 2, latest: 20 }), /2封/)
})

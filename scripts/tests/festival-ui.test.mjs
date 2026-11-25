import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// UI 接线用静态源码断言：这些字符串在实现落地前不存在，因此本文件先红。
const ROOT = new URL('../../', import.meta.url)

function source(relativePath) {
  return readFileSync(new URL(relativePath, ROOT), 'utf8')
}

test('result.ts：领取结果面板接入 festival-result / openFestivalShareCard / shareText', () => {
  const result = source('src/renderer/ui/result.ts')
  assert.ok(result.includes('festival-result'), 'result.ts 缺少 festival-result 容器')
  assert.ok(result.includes('openFestivalShareCard'), 'result.ts 缺少 openFestivalShareCard 调用')
  assert.ok(result.includes('shareText'), 'result.ts 缺少 shareText 展示')
})

test('result.css：餐盒开箱动画关键帧 festival-box-open', () => {
  const css = source('src/renderer/ui/css/result.css')
  assert.ok(css.includes('@keyframes festival-box-open'), 'result.css 缺少 @keyframes festival-box-open')
})

test('pet/calendar.ts：日历台词接入 festivalLineForDayKey', () => {
  const calendar = source('src/renderer/pet/calendar.ts')
  assert.ok(calendar.includes('festivalLineForDayKey'), 'calendar.ts 未接入 festivalLineForDayKey')
})

test('ui/share-card.ts：分享卡渲染使用 festivalShareCardSvg', () => {
  const shareCard = source('src/renderer/ui/share-card.ts')
  assert.ok(shareCard.includes('festivalShareCardSvg'), 'share-card.ts 缺少 festivalShareCardSvg')
})

test('ui/email.ts：邮件领取接入 showResult 与 festival 分支', () => {
  const email = source('src/renderer/ui/email.ts')
  assert.ok(email.includes('showResult'), 'email.ts 未接入 showResult')
  assert.ok(email.includes('festival'), 'email.ts 未接入 festival 分支')
})

test('ui/mobile/phone-email.ts：移动端邮件领取接入 showResult', () => {
  const phoneEmail = source('src/renderer/ui/mobile/phone-email.ts')
  assert.ok(phoneEmail.includes('showResult'), 'phone-email.ts 未接入 showResult')
})

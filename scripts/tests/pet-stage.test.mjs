// 手机菜单顶部的宠物舞台：纯几何模型（不碰 DOM）的布局/滚动裁剪断言，外加
// 「舞台真的接进了手机菜单、main.ts 按舞台盒布局 #pet、互动复用 poke」的源码接线断言。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { petStageBox } from '../../src/renderer/ui/mobile/pet-stage-model.ts'

const read = (rel) => readFileSync(new URL(`../../src/renderer/${rel}`, import.meta.url), 'utf8')

const slotAt = (left, top, width, height) => ({ left, top, width, height })
const view = (top, bottom) => ({ top, bottom })

test('常规布局：按宽度放大、水平居中、底边留 8dp、尺寸取整', () => {
  // 412 dp 宽卡片、300 dp 高的舞台：size = floor(min(412*0.82=337.84, 300)) = 300。
  // 300 > slot 高 300-8，盒子向上溢出 8dp，被 body 顶部裁掉。
  const box = petStageBox(slotAt(0, 100, 412, 300), view(100, 1000))
  assert.deepEqual(box, { left: 56, top: 92, size: 300, clipTop: 8, clipBottom: 0 })
  // 居中：左右留白相等（卡片更宽时同样居中）。
  const wide = petStageBox(slotAt(0, 100, 560, 300), view(100, 1000))
  assert.equal(wide.left, 130)
  assert.equal(560 - (wide.left + wide.size), wide.left, '居中：左右留白相等')
  // 底对齐留 8 dp：宠物盒底边 = slot 底边 - 8。
  assert.equal(wide.top + wide.size, 100 + 300 - 8)
})

test('舞台盒上限 300dp，只由宽度决定；盒子允许向上溢出 slot', () => {
  const huge = petStageBox(slotAt(0, 0, 800, 500), view(0, 600))
  assert.equal(huge.size, 300, 'size 上限 300')
  assert.equal(huge.left, 250)
  assert.equal(huge.top, 192)
  assert.equal(huge.clipTop, 0)

  const capped = petStageBox(slotAt(0, 0, 800, 500), view(0, 600), 200)
  assert.equal(capped.size, 200, 'maxSize 覆盖默认上限')
  assert.equal(capped.left, 300)
  assert.equal(capped.top, 292)

  // 矮舞台不再把宠物压小：slot 高 120 仍取 300，盒子向上溢出并裁掉透明边距。
  const shallow = petStageBox(slotAt(0, 0, 412, 120), view(0, 400))
  assert.equal(shallow.size, 300, 'size 只由宽度与上限决定')
  assert.equal(shallow.top, -188)
  assert.equal(shallow.clipTop, 188)
  assert.ok(shallow.top < 0, '盒子可以向上溢出 slot')

  const small = petStageBox(slotAt(0, 0, 320, 220), view(0, 800))
  assert.equal(small.size, 262, 'size = floor(320*0.82)')
  assert.equal(small.left, 29)
  assert.equal(small.top, -50)
  assert.equal(small.clipTop, 50)
  assert.ok(small.size < huge.size, '舞台变窄时宠物随之缩小')
})

test('滚动裁剪：slot 部分滚出可视区上边界 → clipTop > 0', () => {
  const partial = petStageBox(slotAt(0, -50, 412, 300), view(0, 1000))
  assert.ok(partial, '仍有一半在可视区，不能返回 null')
  assert.equal(partial.top, -58)
  assert.equal(partial.clipTop, 58)
  assert.equal(partial.clipBottom, 0)

  // 下边界同理：可视区底边之下的部分被裁掉。
  const below = petStageBox(slotAt(0, 100, 412, 300), view(100, 300))
  assert.equal(below.clipBottom, 92)
  assert.equal(below.clipTop, 8, '盒顶本来就有 8dp 溢出 slot')
})

test('完全滚出可视区（上/下）→ null，滚回来立即恢复', () => {
  assert.equal(petStageBox(slotAt(0, -292, 412, 300), view(0, 1000)), null, '整只宠物滚到可视区上方')
  assert.equal(petStageBox(slotAt(0, -500, 412, 300), view(0, 1000)), null, '滚得更远仍为 null')
  assert.equal(petStageBox(slotAt(0, 1000, 412, 300), view(0, 800)), null, '整只宠物在可视区下方')
  assert.ok(petStageBox(slotAt(0, -200, 412, 300), view(0, 1000)), '还剩 92dp 可见时必须返回盒子')
})

test('小数尺寸一律取整，退化槽位返回 null', () => {
  const box = petStageBox(slotAt(11.5, 100.4, 411.6, 285.4), view(100.4, 900))
  assert.ok(box)
  for (const key of ['left', 'top', 'size', 'clipTop', 'clipBottom']) {
    assert.ok(Number.isInteger(box[key]), `${key} 必须是整数 dp: ${box[key]}`)
  }
  assert.equal(box.size, 300)
  assert.equal(box.left, 67)
  assert.equal(box.top, 78)
  assert.equal(box.clipTop, 22)
  assert.equal(petStageBox(slotAt(0, 0, 0, 0), view(0, 0)), null, '没有宽度就没有舞台')
})

test('菜单把舞台放在滚动内容的第一块，点位负责逗宠', () => {
  const phone = read('ui/mobile/phone-menu.ts')
  assert.match(phone, /qp-menu-pet-stage/)
  assert.match(phone, /qp-menu-pet-slot/)
  // 互动没关（faceClick=1/2）就显示提示；点位在舞台里是隐形的。
  assert.match(phone, /if \(save\.settings\.faceClick !== 0\) stage\.append\(div\('qp-menu-pet-hint', '点击宠物逗它'\)\)/)
  // 舞台必须在身份行之前（滚动内容的第一块），随列表一起滚走。
  const stageAt = phone.indexOf('body.append(stage)')
  const headerAt = phone.indexOf('body.append(head.el)')
  assert.ok(stageAt >= 0 && headerAt > stageAt, '舞台容器必须是 .qp-menu 的第一个子元素')
  // 点舞台空白/宠物身体只是重新显示点位；真正的逗宠是 .point 自己的 click。
  assert.match(phone, /stage\.addEventListener\('click', \(\) => \{[\s\S]{0,200}?ruffle-player\[data-swf\*="\/interact\/"\][\s\S]{0,100}?showFacePoints\(\)/, '舞台 click 只负责显示点位，避开 interact 播放')
  assert.match(phone, /if \(id === 'face'\) \{[\s\S]{0,160}?showFacePoints\(\)[\s\S]{0,80}?return/, '「逗它」瓦片原地显示点位')
  // 轻点宠物时 input 的 end 会先把贴边宠物切成 Hide_left/right（可能还在队列里）；
  // 舞台不能放大那条剪影，所以按位置判断并主动唤回站姿。
  assert.match(phone, /if \(edgeSide\(\) !== null\) machine\.play\(\{ a: 'normal' \}\)/, '贴边时先唤回站姿再搬进舞台')
  assert.match(phone, /openPetStage\(stageSlot\)/, 'sheet 打开后把真实宠物搬进舞台')
  // 打开时先按 300dp 盒重画点位，之后 400ms watcher 在 poke 播完、回站姿后补回来。
  assert.match(phone, /window\.setInterval\(\(\) => \{[\s\S]{0,160}?showFacePoints\(\)[\s\S]{0,40}?\}, 400\)/, '打开即画并用 400ms watcher 补回点位')
  assert.match(phone, /ruffle-player\[data-swf\*="\/interact\/"\]/, 'watcher/舞台点击都要避开 interact 预载窗口')
  assert.match(phone, /clearInterval\(pointWatcher\)/, 'onClose/释放时清掉 watcher')
  // 手机轻点宠物会先显示桌面热点（#113 的 showFacePointsAfterClick），进菜单后按新盒子尺寸重画。
  assert.match(phone, /import \{[^}]*clearFacePoints[^}]*\} from '\.\.\/face'/)
  assert.ok(phone.indexOf('clearFacePoints()') < phone.indexOf('openPetStage('), '打开菜单时先清旧点位，再进舞台')
  assert.match(phone, /stageHandle\?\.close\(\)/, 'sheet 的所有关闭路径都要释放舞台')
  assert.doesNotMatch(phone, /pokePetRandom/, '随机逗宠已删除')
  // 48dp 头像列改由舞台承担；身份行保留昵称/Lv/› 与三条状态。
  assert.doesNotMatch(phone, /qp-menu-avatar/, '48dp 头像已删除')
  assert.match(phone, /qp-menu-name/)
  assert.match(phone, /qp-menu-stats/)
  // 状态条必须能原地刷新：逗宠后心情文本要立刻从旧值变成新值，而不是等下次开菜单。
  assert.match(phone, /let refreshStats: \(\(\) => void\) \| null = null/)
  assert.match(phone, /onInfoChange\(\(key\) => \{\s*if \(key === 'hunger' \|\| key === 'clean' \|\| key === 'mood'\) refreshStats\?\.\(\)\s*\}\)/, 'onInfoChange 只注册一次')
  assert.match(phone, /valueEl\.textContent = String\(Math\.round\(value\)\)/, '更新数字文本')
  assert.match(phone, /fill\.style\.width = `\$\{Math\.round\(ratio \* 100\)\}%`/, '更新条宽')
  assert.match(phone, /refreshStats = ownRefresh/)
  assert.match(phone, /if \(refreshStats === ownRefresh\) refreshStats = null/, '只清自己那份')
})

test('舞台控制器只依赖几何模型，监听滚动/旋转并按帧重算', () => {
  const stage = read('ui/mobile/pet-stage.ts')
  assert.match(stage, /from '\.\/pet-stage-model'/)
  assert.match(stage, /export function stageBox\(\): PetStageBox \| null/)
  assert.match(stage, /import \{ setPetStaged \} from '\.\.\/\.\.\/pet\/store'/, '激活状态由 store 持有')
  assert.match(stage, /setPetStaged\(true\)/)
  assert.match(stage, /setPetStaged\(false\)/)
  assert.match(stage, /export function onStageBox\(listener: \(\) => void\): \(\) => void/)
  assert.match(stage, /export function openPetStage\(slot: HTMLElement\): PetStageHandle/)
  assert.match(stage, /closest<HTMLElement>\('\.qp-sheet-body'\)/, '滚动容器来自 slot 所在的 sheet body')
  assert.match(stage, /addEventListener\('scroll', [^,]+, \{ passive: true \}\)/)
  assert.match(stage, /addEventListener\('resize'/)
  assert.match(stage, /addEventListener\('orientationchange'/)
  // 入场动画掉帧时不能停在中间位置：卡片动画结束必须再量一次。
  assert.match(stage, /closest<HTMLElement>\('\.qp-sheet-card'\)/)
  assert.match(stage, /addEventListener\('animationend'/)
  assert.match(stage, /addEventListener\('transitionend'/)
  assert.match(stage, /requestAnimationFrame/)
  assert.match(stage, /petStageBox\(/)
  assert.match(stage, /BURST_MS = 300/, '入场动画期间逐帧重算')
  assert.doesNotMatch(stage, /info\.lastX|setInfo|petSize\(/, '舞台不碰存档里的位置与尺寸')
})

test('main.ts 舞台期间只按舞台盒布局，并停止上报宠物触控区', () => {
  const main = read('main.ts')
  assert.match(main, /import \{[^}]*stageBox[^}]*\} from '\.\/ui\/mobile\/pet-stage'/)
  assert.match(main, /import \{[^}]*petStaged[^}]*\} from '\.\/pet\/store'/, '舞台状态是 store 的单一事实源')
  assert.match(main, /onStageBox\(\(\) => layout\(\)\)/, '几何变化驱动一次 layout')
  assert.match(main, /if \(petStaged\(\)\) \{\s*const box = stageBox\(\)\s*if \(box\) applyStage\(box\)\s*else hideStage\(\)\s*return\s*\}/)
  assert.match(main, /function applyStage\(box: PetStageBox\): void \{[\s\S]*?petEl\.style\.left = `\$\{box\.left\}px`[\s\S]*?petEl\.style\.top = `\$\{box\.top\}px`[\s\S]*?petEl\.style\.width = petEl\.style\.height = `\$\{box\.size\}px`[\s\S]*?clipPath = `inset\(\$\{box\.clipTop\}px 0 \$\{box\.clipBottom\}px 0\)`/)
  assert.match(main, /function hideStage\(\): void \{\s*petEl\.style\.display = 'none'/)

  const hitBoxes = main.slice(main.indexOf('function petHitBoxes'), main.indexOf('const overPet'))
  assert.match(hitBoxes, /if \(petStaged\(\)\) return \[\]/, '舞台期间宠物只是视觉层')
  const visibleBoxes = main.slice(main.indexOf('function visiblePetBoxes'), main.indexOf('const syncDesktop'))
  assert.match(visibleBoxes, /if \(petStaged\(\)\) return \[\]/, '不能把舞台像素上报成原生触控区')

  const windowRect = main.slice(main.indexOf('GetWindowRect'), main.indexOf('GetPrivateProfileString'))
  assert.match(windowRect, /stageBox\(\)/, 'SWF 读到的窗口就是舞台盒')

  const input = main.slice(main.indexOf('const petInput = createPetInput({'), main.indexOf('}, touch ? HOLD_MS : 0)'))
  const guards = input.match(/petStaged\(\)\) return/g) ?? []
  assert.ok(guards.length >= 6, `begin/hold/tap/lift/move/end 都要在舞台期间退出，实际 ${guards.length}`)
})

test('face.ts 保留原点位 poke 路径，不再有随机逗宠', () => {
  const face = read('ui/face.ts')
  assert.doesNotMatch(face, /pokePetRandom/, '随机逗宠已删除')
  assert.match(face, /export function showFacePoints\(\): void \{[\s\S]{0,500}?if \(layer\.childElementCount\) return/, '重复调用不重建点位（保住脉冲动画）')
  assert.match(face, /d\.addEventListener\('click', \(\) => poke\(key, dir, p\.s, p\.e \?\? p\.s\)\)/, '点位 click 仍走 poke(key, dir, s, e)')
  assert.match(face, /let lastPoke = 0/)
  assert.match(face, /lastPoke = Date\.now\(\)/)
  assert.match(face, /petStaged\(\) && Date\.now\(\) - lastPoke < 300/, 'poke 预载窗口由点位 owner 防住')
})

test('pet.ts 的 idle 在舞台期间不跑', () => {
  const pet = read('pet/pet.ts')
  assert.match(pet, /import \{[\s\S]*?petStaged[\s\S]*?\} from '\.\/store'/, 'idle 守卫从 store 取舞台状态')
  assert.doesNotMatch(pet, /ui\/mobile\/pet-stage/, 'pet 核心不直接依赖手机 UI 模块')
  assert.match(pet, /if \(petStaged\(\)\) \{\s*stopWalk\(\)\s*return\s*\}/, '舞台期间已开始的走路也要停')
  const idle = pet.slice(pet.indexOf('function idle(): void'), pet.indexOf('function line('))
  assert.match(idle, /if \(petStaged\(\)\)/, '舞台期间必须先拦 idle')
  assert.ok(idle.indexOf('petStaged()') < idle.indexOf('maybeLead'), 'guard 必须在走/玩/说话之前')
  assert.match(idle, /petStaged\(\)\) \{[\s\S]{0,160}?scheduleIdle\(\)[\s\S]{0,40}?return/, '拦下后重新排队，别让 idle 链断掉')
})

test('store 的舞台守卫：applyEdge 在舞台期间不躲边', () => {
  const store = read('pet/store.ts')
  assert.match(store, /let staged = false/)
  assert.match(store, /export const petStaged = \(\): boolean => staged/)
  assert.match(store, /export function setPetStaged\(v: boolean\): void \{\s*staged = v\s*\}/)
  // 兜底动作（machine.ts 的 applyEdge()）、snapEdge、walk 收尾共用这一处守卫。
  assert.match(store, /export function applyEdge\(\): 'hideleft' \| 'hideright' \| null \{\s*\/\/[^\n]*\n\s*if \(staged\) return null/)
})

test('menu-phone.css：所有选择器都在 body.qp-phone 作用域，且舞台层级高于 sheet', () => {
  const css = read('ui/mobile/menu-phone.css').replace(/\/\*[\s\S]*?\*\//g, '')
  const selectors = [...css.matchAll(/([^{}]+)\{/g)]
    .map((match) => match[1].trim())
    .filter((selector) => !selector.startsWith('@') && !/^(from|to|\d+%)$/.test(selector))
  assert.ok(selectors.length > 0)
  for (const selector of selectors) {
    for (const one of selector.split(',')) {
      assert.match(one.trim(), /^body\.qp-phone\b/, `舞台样式逃出了手机作用域: ${one.trim()}`)
    }
  }
  assert.doesNotMatch(css, /\.ui-menu/, '桌面弹出菜单不能被重排')

  assert.match(css, /\.qp-menu-pet-stage[^{]*\{[^}]*height:\s*clamp\(240px,\s*30vh,\s*320px\)/s)
  assert.match(css, /\.qp-menu-pet-stage[^{]*\{[^}]*background:[\s\S]*?at 50% 78%/s, '光晕对准角色站位')
  assert.match(css, /\.qp-menu-pet-stage::after[^{]*\{[^}]*width:\s*55%[^}]*height:\s*18px/s, '地面阴影尺寸')
  assert.match(css, /\.qp-menu-pet-stage::after[^{]*\{[^}]*background:\s*radial-gradient\(closest-side,\s*rgba\(0,\s*0,\s*0,\s*0\.16\),\s*transparent\)/s, '地面椭圆阴影')
  assert.match(css, /\.qp-menu-pet-hint[^{]*\{[^}]*font-size:\s*13px[^}]*text-align:\s*center/s)
  assert.match(css, /#pet\.qp-pet-stage[^{]*\{[^}]*z-index:\s*695[^}]*pointer-events:\s*none/s, '宠物层在 sheet(690) 之上、box(700) 之下')
  assert.match(css, /#pet\.qp-pet-stage \*[^{]*\{[^}]*pointer-events:\s*none !important/s, 'Ruffle 会内联 pointer-events:auto，必须压掉')
  assert.match(css, /#pet\.qp-pet-stage \.point[^{]*\{[^}]*width:\s*16px[^}]*height:\s*16px[^}]*pointer-events:\s*auto !important/s, '点位视觉 16dp 且必须可点')
  assert.match(css, /#pet\.qp-pet-stage \.point[^{]*\{[^}]*background:\s*none !important[^}]*animation:\s*none/s, '点位视觉必须隐形（无 click.svg、无脉冲）')
  assert.match(css, /#pet\.qp-pet-stage \.point::after[^{]*\{[^}]*inset:\s*-10px[^}]*border-radius:\s*50%/s, '命中区外扩到约 36dp')
  // 关闭时 sheet 的 180ms 淡出期间，放大宠物必须跟着一起淡出，不能悬在淡出面板上。
  assert.match(css, /#pet\.qp-pet-stage[^{]*\{[^}]*transition:\s*opacity 0\.18s ease-in/s, '关闭时与 sheet 同步淡出')
  assert.match(css, /body\.qp-phone:not\(\.qp-sheet-open\) #pet\.qp-pet-stage[^{]*\{[^}]*opacity:\s*0/s, 'qp-sheet-open 摘掉后宠物淡出')
  assert.match(css, /\.qp-menu-head[^{]*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s, '头像删除后身份行改为单列')
  assert.doesNotMatch(css, /\.qp-menu-avatar/, '头像规则已随 48dp 头像一起删除')
})

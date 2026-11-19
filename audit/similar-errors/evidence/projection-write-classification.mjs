// 证据：projection 模式下 update() 的 canonical 写会被 assertDeviceLocalSavePatch 拒绝；哪些键允许（device-local/presentation）。
// 运行：node --experimental-strip-types audit/similar-errors/evidence/projection-write-classification.mjs
import { registerHooks } from 'node:module'
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL && /\/src\/shared\//.test(context.parentURL) &&
        /\.[cm]?[jt]s$/.test(specifier) === false && specifier.endsWith('.json') === false) return nextResolve(specifier + '.ts', context)
    return nextResolve(specifier, context)
  },
})
const ROOT = new URL('../../..', import.meta.url)
const { assertDeviceLocalSavePatch } = await import(new URL('src/shared/renderer-projection.ts', ROOT).href)
for (const patch of [
  { saveJsonData: { freeze: '1' } },
  { saveJsonData: { album: '[]' } },
  { saveJsonData: { careLog: '[]' } },
  { saveJsonData: { weather: '{}' } },
  { settings: { faceClick: 1 } },
  { settings: { undying: true } },
]) {
  try {
    assertDeviceLocalSavePatch(patch)
    console.log(JSON.stringify(patch), '=> allowed')
  } catch (error) {
    console.log(JSON.stringify(patch), '=> THROWS', error.name + ':', error.message)
  }
}

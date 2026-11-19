// Static consistency check: renderer-local TASKS (src/renderer/pet/tasks.ts) vs
// canonical STATIC_TASKS (src/shared/pet-runtime/content/tasks.json).
// Read-only. Run: node audit/similar-errors/findings/ui-divergence/evidence/check-task-tables.mjs
import { readFileSync } from 'node:fs'

const ts = readFileSync('src/renderer/pet/tasks.ts', 'utf8')
const start = ts.indexOf("const TASKS: Record<Exclude<Tab, 'daily'>, Task[]> = {")
if (start < 0) throw new Error('TASKS literal not found')
const open = ts.indexOf('{', start)
let depth = 0
let end = -1
for (let i = open; i < ts.length; i++) {
  const c = ts[i]
  if (c === '{') depth++
  else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break } }
}
const literal = ts.slice(open, end)
// TASKS reuses the DDW constant from the same module; bind it explicitly.
const ddw = /const DDW = '([^']*)'/.exec(ts)
if (ddw === null) throw new Error('DDW literal not found')
const renderer = new Function('DDW', 'return ' + literal)(ddw[1])
const canonical = JSON.parse(readFileSync('src/shared/pet-runtime/content/tasks.json', 'utf8')).tasks

const tabs = ['ddw', 'growth', 'travel']
let diffs = 0
for (const tab of tabs) {
  const a = JSON.stringify(renderer[tab])
  const b = JSON.stringify(canonical[tab])
  const same = a === b
  if (!same) diffs++
  console.log(`${tab}: ${same ? 'IDENTICAL' : 'DIFFERENT'} (renderer ${renderer[tab].length} entries, canonical ${canonical[tab].length} entries)`)
}

// Reward codes that the renderer would ROLL locally vs the codes the canonical
// template fixes. Only `good` is comparable; `reroll` counts must match too.
for (const tab of tabs) {
  renderer[tab].forEach((t, i) => {
    const c = canonical[tab][i]
    const fixedSame = JSON.stringify(t.good ?? null) === JSON.stringify(c.good ?? null)
    const rerollSame = (t.reroll ?? 0) === (c.reroll ?? 0)
    if (!fixedSame || !rerollSame) {
      diffs++
      console.log(`DIFF ${tab}[${i}] label=${t.label} good=${JSON.stringify(t.good)} vs ${JSON.stringify(c.good)} reroll=${t.reroll} vs ${c.reroll}`)
    }
  })
}
console.log(`tabs with reroll templates (local Math.random loot at load): ${tabs.map(t => t + '=' + renderer[t].filter(x => x.reroll).length).join(' ')}`)
console.log(diffs === 0 ? 'RESULT: tables identical; no static drift' : `RESULT: ${diffs} difference(s)`)

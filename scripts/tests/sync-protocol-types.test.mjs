import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const TSC = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./fixtures/c2-protocol-types.ts', import.meta.url))

test('typed command results, wire results and secret-free session projections compile', () => {
  const result = spawnSync(process.execPath, [
    TSC,
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    '--target', 'ES2023',
    '--module', 'ESNext',
    '--moduleResolution', 'Bundler',
    FIXTURE,
  ], { encoding: 'utf8' })
  assert.equal(result.status, 0, (result.stdout ?? '') + (result.stderr ?? ''))
})

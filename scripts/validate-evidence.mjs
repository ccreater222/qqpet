/** Fail-closed validator for one C12 machine-readable evidence report. */
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  validateDockerSmokeReport,
  validateE2EReport,
  validateProxySmokeReport,
} from './lib/acceptance-evidence.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DEFAULT_REPORTS = {
  e2e: join(ROOT, 'docs/superpowers/acceptance/artifacts/c12-e2e/c12-e2e-report.json'),
  docker: join(ROOT, 'docs/superpowers/acceptance/artifacts/c12-docker/docker-smoke-report.json'),
  proxy: join(ROOT, 'docs/superpowers/acceptance/artifacts/c12-proxy/proxy-smoke-report.json'),
}

function currentRevision() {
  const configured = process.env.QQPET_CODE_REVISION?.trim()
  if (configured) return configured
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
}

async function main() {
  const kind = process.argv[2] ?? ''
  const reportPath = process.argv[3] ?? DEFAULT_REPORTS[kind]
  if (['e2e', 'docker', 'proxy'].includes(kind) === false || typeof reportPath !== 'string') {
    throw new Error('usage: node scripts/validate-evidence.mjs <e2e|docker|proxy> [report-path]')
  }
  const options = {
    currentRevision: currentRevision(),
    nowMs: Date.now(),
    notBeforeMs: process.env.QQPET_EVIDENCE_NOT_BEFORE_MS === undefined
      ? undefined
      : Number(process.env.QQPET_EVIDENCE_NOT_BEFORE_MS),
  }
  let report
  try {
    report = JSON.parse(await readFile(reportPath, 'utf8'))
  } catch (error) {
    throw new Error('could not read ' + reportPath + ': ' + (error instanceof Error ? error.message : String(error)))
  }
  if (kind === 'e2e') {
    // C12 acceptance requires provable real BrowserWindow/preload/renderer
    // execution. The validator below fails closed when any flag/proof is absent;
    // surface the evidence summary here so a passing run is auditable.
    const evidence = report?.evidence ?? {}
    process.stdout.write('[evidence] e2e rendererCoverage=' + String(evidence.rendererCoverage === true)
      + ' guiCoverage=' + String(evidence.guiCoverage === true)
      + ' browserWindows=' + String(evidence.rendererProof?.browserWindowCount ?? 'missing')
      + ' rendererProcesses=' + String(evidence.rendererProof?.rendererProcessCount ?? 'missing')
      + '\n')
  }
  const validation = kind === 'e2e'
    ? validateE2EReport(report, options)
    : kind === 'docker'
      ? validateDockerSmokeReport(report, options)
      : validateProxySmokeReport(report, options)
  if (validation.ok === false) {
    process.stderr.write('[evidence] FAIL ' + kind + ': ' + reportPath + '\n')
    for (const error of validation.errors) process.stderr.write('- ' + error + '\n')
    process.exitCode = 1
    return
  }
  process.stdout.write('[evidence] PASS ' + kind + ': ' + reportPath + '\n')
}

main().catch(error => {
  process.stderr.write('[evidence] FAILED: ' + (error instanceof Error ? error.message : String(error)) + '\n')
  process.exitCode = 1
})

/** Fail-closed validator for one C12 machine-readable evidence report. */
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  validateDockerSmokeReport,
  validateE2EReport,
  validateProxySmokeReport,
} from './lib/acceptance-evidence.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DEFAULT_REPORTS = {
  e2e: resolve(ROOT, 'docs/superpowers/acceptance/artifacts/c12-e2e/c12-e2e-report.json'),
  docker: resolve(ROOT, 'docs/superpowers/acceptance/artifacts/c12-docker/docker-smoke-report.json'),
  proxy: resolve(ROOT, 'docs/superpowers/acceptance/artifacts/c12-proxy/proxy-smoke-report.json'),
}
const ACCEPTANCE_EVIDENCE_PREFIX = 'docs/superpowers/acceptance/'
const COMMIT_REVISION_PATTERN = /^[0-9a-f]{40}$/i

function gitRevision(env = process.env) {
  const configured = env.QQPET_CODE_REVISION?.trim()
  if (configured) return configured
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
}

function gitHeadRevision() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
}

function isAncestorRevision(testedRevision, headRevision) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', testedRevision, headRevision], {
      cwd: ROOT,
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

function changedTrackedPaths(fromRevision, toRevision) {
  const args = ['diff', '--name-only', '--no-renames', '-z']
  args.push(toRevision === undefined ? fromRevision : fromRevision + '..' + toRevision)
  args.push('--')
  const output = execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  return output.split('\0').filter(path => path.length > 0)
}

function isAcceptanceEvidencePath(path) {
  return path.startsWith(ACCEPTANCE_EVIDENCE_PREFIX) && path.length > ACCEPTANCE_EVIDENCE_PREFIX.length
}

/**
 * An evidence report may lag HEAD only by the commit that checked it in. The
 * tested revision must be a real ancestor of HEAD, and both the committed
 * tested..HEAD diff and the actual working tree relative to tested must touch
 * only tracked acceptance evidence/docs. This keeps source/scripts/config/test
 * changes fail-closed while allowing the evidence-only child commit itself.
 */
function evidenceOnlyDescendant(testedRevision, currentRevision) {
  if (typeof testedRevision !== 'string'
    || typeof currentRevision !== 'string'
    || COMMIT_REVISION_PATTERN.test(testedRevision) === false
    || COMMIT_REVISION_PATTERN.test(currentRevision) === false
    || testedRevision.toLowerCase() === currentRevision.toLowerCase()) {
    return null
  }
  let headRevision
  try {
    headRevision = gitHeadRevision()
  } catch {
    return null
  }
  // QQPET_CODE_REVISION is a report-generation override, not a replacement for
  // proving the checked-out HEAD's ancestry. Descendant acceptance always uses
  // the actual checked-out commit.
  if (headRevision.toLowerCase() !== currentRevision.toLowerCase()) return null
  if (isAncestorRevision(testedRevision, headRevision) === false) return null

  let committedPaths
  let workingTreePaths
  try {
    committedPaths = changedTrackedPaths(testedRevision, headRevision)
    workingTreePaths = changedTrackedPaths(testedRevision)
  } catch {
    return null
  }
  const changedPaths = [...new Set([...committedPaths, ...workingTreePaths])]
  if (changedPaths.every(isAcceptanceEvidencePath) === false) return null
  return { testedRevision, headRevision, changedPaths }
}

async function main() {
  const kind = process.argv[2] ?? ''
  const reportPath = process.argv[3] ?? DEFAULT_REPORTS[kind]
  if (['e2e', 'docker', 'proxy'].includes(kind) === false || typeof reportPath !== 'string') {
    throw new Error('usage: node scripts/validate-evidence.mjs <e2e|docker|proxy> [report-path]')
  }
  let report
  try {
    report = JSON.parse(await readFile(reportPath, 'utf8'))
  } catch (error) {
    throw new Error('could not read ' + reportPath + ': ' + (error instanceof Error ? error.message : String(error)))
  }

  const configuredRevision = gitRevision()
  const reportRevision = typeof report?.codeRevision === 'string' ? report.codeRevision : ''
  let acceptedDescendant = null
  if (reportRevision.length > 0 && reportRevision !== configuredRevision) {
    acceptedDescendant = evidenceOnlyDescendant(reportRevision, configuredRevision)
    if (acceptedDescendant !== null) {
      process.stdout.write('[evidence] evidence-only descendant accepted: tested='
        + acceptedDescendant.testedRevision + ' head=' + acceptedDescendant.headRevision
        + ' changedPaths=' + acceptedDescendant.changedPaths.length + '\n')
    }
  }
  // The pure reports validator stays strict: it is only given the tested
  // revision after the CLI has proved the evidence-only descendant relation.
  const options = {
    currentRevision: acceptedDescendant?.testedRevision ?? configuredRevision,
    nowMs: Date.now(),
    notBeforeMs: process.env.QQPET_EVIDENCE_NOT_BEFORE_MS === undefined
      ? undefined
      : Number(process.env.QQPET_EVIDENCE_NOT_BEFORE_MS),
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

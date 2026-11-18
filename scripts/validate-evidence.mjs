/** Fail-closed validator for one C12 machine-readable evidence report. */
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseGitStatusPorcelain,
  validateDockerSmokeReport,
  validateE2EReport,
  validateGateSummary,
  validateProxySmokeReport,
} from './lib/acceptance-evidence.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DEFAULT_REPORTS = {
  e2e: resolve(ROOT, 'docs/superpowers/acceptance/artifacts/c12-e2e/c12-e2e-report.json'),
  docker: resolve(ROOT, 'docs/superpowers/acceptance/artifacts/c12-docker/docker-smoke-report.json'),
  proxy: resolve(ROOT, 'docs/superpowers/acceptance/artifacts/c12-proxy/proxy-smoke-report.json'),
  gate: resolve(ROOT, 'docs/superpowers/acceptance/artifacts/c12-gate/gate-summary.json'),
}
const ACCEPTANCE_EVIDENCE_PREFIX = 'docs/superpowers/acceptance/'
const COMMIT_REVISION_PATTERN = /^[0-9a-f]{40}$/i

function gitHeadRevision() {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim()
  if (COMMIT_REVISION_PATTERN.test(revision) === false) {
    throw new Error('git rev-parse HEAD did not return a commit revision')
  }
  return revision
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

function workingTreeStatusPaths() {
  const output = execFileSync('git', [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  const paths = []
  for (const entry of parseGitStatusPorcelain(output)) {
    paths.push(entry.path)
    if (typeof entry.previousPath === 'string') paths.push(entry.previousPath)
  }
  return [...new Set(paths)]
}

function isAcceptanceEvidencePath(path) {
  return path.startsWith(ACCEPTANCE_EVIDENCE_PREFIX) && path.length > ACCEPTANCE_EVIDENCE_PREFIX.length
}

/**
 * An evidence report may lag HEAD only by the commit that checked it in. The
 * tested revision must be a real ancestor of the real checked-out HEAD, the
 * working tree (including untracked files) must be completely clean, and the
 * committed tested..HEAD diff must touch only acceptance evidence/docs. This
 * keeps source/scripts/config/test changes fail-closed while allowing the
 * evidence-only child commit itself.
 */
function evidenceOnlyDescendant(testedRevision, headRevision, dirtyPaths) {
  if (typeof testedRevision !== 'string'
    || COMMIT_REVISION_PATTERN.test(testedRevision) === false
    || testedRevision.toLowerCase() === headRevision.toLowerCase()
    || dirtyPaths.length > 0
    || isAncestorRevision(testedRevision, headRevision) === false) {
    return null
  }
  let committedPaths
  try {
    committedPaths = changedTrackedPaths(testedRevision, headRevision)
  } catch {
    return null
  }
  if (committedPaths.length === 0 || committedPaths.every(isAcceptanceEvidencePath) === false) {
    return null
  }
  return { testedRevision, headRevision, changedPaths: committedPaths }
}

function revisionBinding(revision, label, headRevision, dirtyPaths) {
  if (typeof revision !== 'string' || revision.length === 0) {
    return {
      ok: false,
      expectedRevision: headRevision,
      descendant: null,
      error: label + ' revision must be a non-empty 40-character hexadecimal commit revision',
    }
  }
  if (COMMIT_REVISION_PATTERN.test(revision) === false) {
    return {
      ok: false,
      expectedRevision: headRevision,
      descendant: null,
      error: label + ' revision ' + JSON.stringify(revision)
        + ' is not a 40-character hexadecimal commit revision',
    }
  }
  if (revision.toLowerCase() === headRevision.toLowerCase()) {
    return { ok: true, expectedRevision: headRevision, descendant: null, error: null }
  }
  const descendant = evidenceOnlyDescendant(revision, headRevision, dirtyPaths)
  if (descendant !== null) {
    return { ok: true, expectedRevision: revision, descendant, error: null }
  }
  return {
    ok: false,
    expectedRevision: headRevision,
    descendant: null,
    error: label + ' revision ' + revision + ' differs from real HEAD ' + headRevision
      + ' and is not a clean evidence-only descendant',
  }
}

async function main() {
  const kind = process.argv[2] ?? ''
  const reportPath = process.argv[3] ?? DEFAULT_REPORTS[kind]
  if (['e2e', 'docker', 'proxy', 'gate'].includes(kind) === false || typeof reportPath !== 'string') {
    throw new Error('usage: node scripts/validate-evidence.mjs <e2e|docker|proxy|gate> [report-path]')
  }
  let report
  try {
    report = JSON.parse(await readFile(reportPath, 'utf8'))
  } catch (error) {
    throw new Error('could not read ' + reportPath + ': ' + (error instanceof Error ? error.message : String(error)))
  }

  // Resolve the checked-out revision unconditionally. QQPET_CODE_REVISION is
  // only a report-generation override; it never replaces proof against HEAD.
  const headRevision = gitHeadRevision()
  const configuredEnv = process.env.QQPET_CODE_REVISION?.trim()
  const configuredRevision = configuredEnv || headRevision
  const dirtyPaths = workingTreeStatusPaths()
  const configuredBinding = revisionBinding(configuredRevision, 'configured', headRevision, dirtyPaths)
  const reportRevision = typeof report?.codeRevision === 'string' ? report.codeRevision : ''
  const reportBinding = revisionBinding(reportRevision, 'report', headRevision, dirtyPaths)

  const cliErrors = []
  if (configuredBinding.ok === false) cliErrors.push(configuredBinding.error)
  if (reportBinding.ok === false) cliErrors.push(reportBinding.error)
  if (configuredEnv !== undefined && configuredEnv.length > 0 && reportRevision.length > 0
    && configuredRevision.toLowerCase() !== reportRevision.toLowerCase()) {
    cliErrors.push('report codeRevision ' + reportRevision
      + ' does not match configured revision ' + configuredRevision)
  }
  if (dirtyPaths.length > 0) {
    cliErrors.push('working tree must be clean before evidence validation; changed/untracked paths: '
      + dirtyPaths.join(', '))
  }
  if (reportBinding.descendant !== null) {
    process.stdout.write('[evidence] evidence-only descendant accepted: tested='
      + reportBinding.descendant.testedRevision + ' head=' + reportBinding.descendant.headRevision
      + ' changedPaths=' + reportBinding.descendant.changedPaths.length + '\n')
  }

  // The pure report validators stay strict: they are only given the tested
  // revision after the CLI has proved the evidence-only descendant relation.
  const validationOptions = {
    currentRevision: reportBinding.expectedRevision,
    nowMs: Date.now(),
    notBeforeMs: process.env.QQPET_EVIDENCE_NOT_BEFORE_MS === undefined
      ? undefined
      : Number(process.env.QQPET_EVIDENCE_NOT_BEFORE_MS),
  }
  const validation = kind === 'e2e'
    ? validateE2EReport(report, validationOptions)
    : kind === 'docker'
      ? validateDockerSmokeReport(report, validationOptions)
      : kind === 'proxy'
        ? validateProxySmokeReport(report, validationOptions)
        : validateGateSummary(report, validationOptions)
  const errors = [...cliErrors, ...validation.errors]
  if (errors.length > 0) {
    process.stderr.write('[evidence] FAIL ' + kind + ': ' + reportPath + '\n')
    for (const error of errors) process.stderr.write('- ' + error + '\n')
    process.exitCode = 1
    return
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
  process.stdout.write('[evidence] PASS ' + kind + ': ' + reportPath + '\n')
}

main().catch(error => {
  process.stderr.write('[evidence] FAILED: ' + (error instanceof Error ? error.message : String(error)) + '\n')
  process.exitCode = 1
})

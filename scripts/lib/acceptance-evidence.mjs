/**
 * Validation primitives for the C12 release gate.
 *
 * The acceptance gate must never infer success from a command's exit status
 * alone. These validators make the gate fail closed when a report is missing,
 * stale, belongs to another revision, omits required evidence, or records a
 * failed/incomplete scenario.
 */
import { mkdir, rm } from 'node:fs/promises'

/** The current C12 E2E contains 15 substantive named scenarios. */
export const E2E_MIN_STEPS = 15
export const EVIDENCE_MAX_AGE_MS = 30 * 60_000
export const EVIDENCE_FUTURE_SKEW_MS = 2 * 60_000
export const REQUIRED_E2E_EVIDENCE_FLAGS = [
  'twoProcesses',
  'realStandaloneServer',
  'realWebSocket',
]
export const REQUIRED_DOCKER_EVIDENCE_FLAGS = [
  'imageBuilt',
  'containerStarted',
  'readyzReady',
  'nonRoot',
  'backupCreated',
  'backupContentAsserted',
  'restoreSucceeded',
  'restoreContentMatched',
  'postRestoreReadyz',
  'teardown',
]
export const REQUIRED_PROXY_EVIDENCE_FLAGS = [
  'tlsTerminated',
  'nginxProxy',
  'webSocketUpgrade',
  'authenticatedOverWss',
  'syncAliasUpgrade',
  'syncAliasAuthenticated',
  'healthRoute',
  'healthzRoute',
  'readyzRoute',
  'v1SyncRoute',
  'syncRoute',
]

function objectValue(value) {
  return value !== null && typeof value === 'object' && Array.isArray(value) === false ? value : null
}

function validationResult(errors) {
  return { ok: errors.length === 0, errors }
}

function validateCommon(report, options = {}) {
  const errors = []
  const nowMs = options.nowMs ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? EVIDENCE_MAX_AGE_MS
  const futureSkewMs = options.futureSkewMs ?? EVIDENCE_FUTURE_SKEW_MS
  const kind = options.kind ?? 'evidence'
  const parsed = objectValue(report)
  if (parsed === null) {
    errors.push(kind + ' report is missing or not a JSON object')
    return { errors, report: null, finishedAtMs: null }
  }

  if (parsed.result !== 'PASS') {
    errors.push(kind + ' result must be exactly "PASS" (got ' + JSON.stringify(parsed.result) + ')')
  }
  if (typeof parsed.codeRevision !== 'string' || parsed.codeRevision.length === 0) {
    errors.push(kind + ' report must include a non-empty codeRevision')
  } else if (typeof options.currentRevision !== 'string' || options.currentRevision.length === 0) {
    errors.push('current HEAD revision is unavailable for ' + kind + ' comparison')
  } else if (parsed.codeRevision !== options.currentRevision) {
    errors.push(kind + ' codeRevision ' + parsed.codeRevision + ' does not match current HEAD ' + options.currentRevision)
  }

  const startedAtMs = typeof parsed.startedAt === 'string' ? Date.parse(parsed.startedAt) : Number.NaN
  const finishedAtMs = typeof parsed.finishedAt === 'string' ? Date.parse(parsed.finishedAt) : Number.NaN
  if (Number.isFinite(startedAtMs) === false) {
    errors.push(kind + ' report must include a valid startedAt timestamp')
  }
  if (Number.isFinite(finishedAtMs) === false) {
    errors.push(kind + ' report must include a valid finishedAt timestamp')
  } else {
    const ageMs = nowMs - finishedAtMs
    if (ageMs > maxAgeMs) {
      errors.push(kind + ' report is stale: finishedAt is older than ' + Math.round(maxAgeMs / 60_000) + ' minutes')
    }
    if (ageMs < -futureSkewMs) {
      errors.push(kind + ' report finishedAt is in the future by more than ' + Math.round(futureSkewMs / 60_000) + ' minutes')
    }
    if (Number.isFinite(startedAtMs) && finishedAtMs < startedAtMs) {
      errors.push(kind + ' report finishedAt precedes startedAt')
    }
    if (options.notBeforeMs !== undefined && finishedAtMs < options.notBeforeMs) {
      errors.push(kind + ' report was not produced by this gate run (finishedAt precedes gate start)')
    }
  }

  const evidence = objectValue(parsed.evidence)
  if (evidence === null) errors.push(kind + ' report must include an evidence object')
  return { errors, report: parsed, evidence, startedAtMs, finishedAtMs }
}

export function validateE2EReport(report, options = {}) {
  const common = validateCommon(report, { ...options, kind: 'E2E' })
  const errors = [...common.errors]
  const parsed = common.report
  if (parsed === null) return validationResult(errors)

  const minSteps = options.minSteps ?? E2E_MIN_STEPS
  if (Array.isArray(parsed.steps) === false) {
    errors.push('E2E report must include a steps array')
  } else {
    const namedSteps = parsed.steps.filter(step => objectValue(step) !== null
      && typeof step.name === 'string' && step.name.trim().length > 0)
    if (namedSteps.length < minSteps) {
      errors.push('E2E report has ' + namedSteps.length + ' named steps; minimum is ' + minSteps)
    }
    const uniqueNames = new Set(namedSteps.map(step => step.name.trim()))
    if (uniqueNames.size < minSteps) {
      errors.push('E2E report has only ' + uniqueNames.size + ' unique named steps; minimum is ' + minSteps)
    }
    const failedSteps = parsed.steps.filter(step => objectValue(step) === null
      || String(step.status).toLowerCase() !== 'pass')
    if (failedSteps.length > 0) {
      errors.push('E2E report contains ' + failedSteps.length + ' step(s) that are not pass')
    }
    for (const step of namedSteps) {
      if (Number.isFinite(step.durationMs) === false || step.durationMs < 0) {
        errors.push('E2E step "' + step.name + '" has an invalid durationMs')
        break
      }
    }
  }

  const evidence = common.evidence
  if (evidence !== null) {
    for (const flag of REQUIRED_E2E_EVIDENCE_FLAGS) {
      if (evidence[flag] !== true) errors.push('E2E evidence requires ' + flag + ' === true')
    }
    // rendererCoverage is intentionally not required yet. If a future E2E adds
    // renderer automation it must flip this flag to true; false is an honest
    // declaration that GUI/renderer coverage is still absent and is not a pass.
    if (Object.hasOwn(evidence, 'rendererCoverage') && evidence.rendererCoverage !== true) {
      errors.push('E2E rendererCoverage is present but not true')
    }
    if (evidence.guiCoverage === true) {
      errors.push('E2E evidence claims GUI coverage; this gate only accepts tested rendererCoverage === true')
    }
  }
  return validationResult(errors)
}

export function validateDockerSmokeReport(report, options = {}) {
  const common = validateCommon(report, { ...options, kind: 'Docker smoke' })
  const errors = [...common.errors]
  const evidence = common.evidence
  if (evidence !== null) {
    for (const flag of REQUIRED_DOCKER_EVIDENCE_FLAGS) {
      if (evidence[flag] !== true) errors.push('Docker smoke evidence requires ' + flag + ' === true')
    }
    if (evidence.journalMode !== 'wal') {
      errors.push('Docker smoke readiness must report journalMode "wal"')
    }
    if (evidence.synchronous !== 'full') {
      errors.push('Docker smoke readiness must report synchronous "full"')
    }
    if (Number.isSafeInteger(evidence.uid) === false || evidence.uid === 0) {
      errors.push('Docker smoke evidence must record a non-zero integer runtime uid')
    }
  }
  return validationResult(errors)
}

export function validateProxySmokeReport(report, options = {}) {
  const common = validateCommon(report, { ...options, kind: 'TLS/WSS proxy smoke' })
  const errors = [...common.errors]
  const evidence = common.evidence
  if (evidence !== null) {
    for (const flag of REQUIRED_PROXY_EVIDENCE_FLAGS) {
      if (evidence[flag] !== true) errors.push('TLS/WSS proxy smoke evidence requires ' + flag + ' === true')
    }
  }
  return validationResult(errors)
}

/** Remove every old artifact before a gate run so a missing/failed run cannot reuse evidence. */
export async function cleanEvidenceDirectory(directory) {
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
}

/**
 * Pure final gate decision used by the CLI. A command exit status can never
 * override invalid evidence, a changed revision, or stale/missing reports.
 */
export function evaluateAcceptanceGate(options = {}) {
  const revision = typeof options.revision === 'string' ? options.revision : ''
  const revisionAfter = typeof options.revisionAfter === 'string' ? options.revisionAfter : ''
  const expectedStepCount = options.expectedStepCount ?? 0
  const results = Array.isArray(options.results) ? options.results : []
  const commandsPassed = expectedStepCount > 0
    && results.length === expectedStepCount
    && results.every(result => objectValue(result) !== null && result.code === 0)
  const revisionStable = revision.length > 0 && revisionAfter === revision
  const validationOptions = {
    currentRevision: revision,
    nowMs: options.nowMs,
    notBeforeMs: options.notBeforeMs,
  }
  const e2e = validateE2EReport(options.e2eReport, validationOptions)
  const docker = validateDockerSmokeReport(options.dockerReport, validationOptions)
  const proxy = validateProxySmokeReport(options.proxyReport, validationOptions)
  const errors = [
    ...e2e.errors.map(error => 'E2E: ' + error),
    ...docker.errors.map(error => 'Docker: ' + error),
    ...proxy.errors.map(error => 'Proxy: ' + error),
  ]
  if (commandsPassed === false) errors.push('one or more acceptance commands failed or did not run')
  if (revisionStable === false) errors.push('HEAD changed while the acceptance gate was running')
  return {
    ok: commandsPassed && revisionStable && e2e.ok && docker.ok && proxy.ok,
    commandsPassed,
    revisionStable,
    e2e,
    docker,
    proxy,
    errors,
  }
}

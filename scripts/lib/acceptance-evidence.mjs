/**
 * Validation primitives for the C12 release gate.
 *
 * The acceptance gate must never infer success from a command's exit status
 * alone. These validators make the gate fail closed when a report is missing,
 * stale, belongs to another revision, omits required evidence, or records a
 * failed/incomplete scenario.
 */
import { mkdir, rm } from 'node:fs/promises'

/** The current C12 E2E contains all mandatory §16.6 scenarios plus the setup/teardown steps. */
export const E2E_MIN_STEPS = 36
export const EVIDENCE_MAX_AGE_MS = 30 * 60_000
export const EVIDENCE_FUTURE_SKEW_MS = 2 * 60_000
const GENERATED_ACCEPTANCE_EVIDENCE_PREFIX = 'docs/superpowers/acceptance/artifacts/'
const GENERATED_ACCEPTANCE_REPORT_PATTERN = /^docs\/superpowers\/acceptance\/\d{4}-\d{2}-\d{2}-c12-final-gate\.md$/
const GENERATED_TEMP_PATH_PATTERN = /^out\/(?:docker-smoke-|compose-smoke-|proxy-smoke-|acceptance-gate-)/
export const REQUIRED_E2E_SCENARIO_NAMES = Object.freeze([
  'two-renderer competing actions reject exactly one canonical mutation',
  'game diudiule exam island-quiz session token abuse is rejected without answer keys',
  'fresh-host portable import preserves engine jobs sessions rng environment and anchor without double catch-up',
  'connected reset reopens exact survivor coverage',
  'startup crash repair uses heartbeat grace and reconnects without duplicate events',
  'deterministic restart preserves engine jobs sessions rng environment and anchor without duplicate catch-up',
  'revoked renderer reconnect is rejected after relaunch',
  'feed latency p95 across ten renderer commands',
  'timed work completes exactly once at server-owned deadline across restart',
  'advanceWhileEmpty true and false have exact zero-client state deltas',
  'online-time and sign-in gift split credits only covered intervals exactly once',
  'real LocalRepository authority detach resume fences epochs and failed imports',
  'renderer kill survivor continues and reconnect resumes without duplicate reward/events',
  'advanceWhileEmpty true zero-client reconnect applies deterministic random events exactly once',
  'renderer direct mutation and legacy SavePatch cannot change canonical state',
  'server SQLite device fields logs and projections exclude never-upload secrets and local-only fields',
  'timed work deadline and completion are observed by both renderers exactly once across restart',
  'exam game diudiule island grading task and reward deltas are exact once without answer-key exposure',
])
export const REQUIRED_E2E_EVIDENCE_FLAGS = [
  'twoProcesses',
  'realStandaloneServer',
  'realWebSocket',
  'realElectron',
  'realRenderer',
  'rendererCoverage',
  'guiCoverage',
  'competingActionsCovered',
  'sessionTokenAbuseCovered',
  'freshHostPortableImportCovered',
  'connectedCoverageReopenCovered',
  'startupCrashRepairCovered',
  'deterministicRestartCovered',
  'revokedReconnectCovered',
  'feedLatencyP95Covered',
  'timedServerDeadlineCovered',
  'advanceWhileEmptyZeroClientCovered',
  'onlineTimeSigninSplitCovered',
  'localAuthorityHandoffCovered',
  'survivorRestartNoDuplicateCovered',
  'advanceWhileEmptyRandomReconnectCovered',
  'rendererMutationBlockedCovered',
  'secretBoundaryAuditCovered',
  'answerKeysAbsent',
  'timedWorkBothRenderersCovered',
  'sessionGradingTaskRewardExactCovered',
  'answerKeyServerSideGradingCovered',
  'restartEngineStatePreservedCovered',
  'portableImportEngineStatePreservedCovered',
  'noDuplicateCatchUpCovered',
]
export const REQUIRED_DOCKER_EVIDENCE_FLAGS = [
  'imageBuilt',
  'containerStarted',
  'readyzReady',
  'nonRoot',
  'ownerAdminCredentialHashed',
  'credentialReadableByRuntime',
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

/**
 * Parse `git status --porcelain=v1 -z --untracked-files=all`. Rename/copy
 * records carry the previous path in the following NUL-delimited token.
 */
export function parseGitStatusPorcelain(output) {
  if (typeof output !== 'string') throw new Error('git status output must be a string')
  const tokens = output.split('\0')
  const entries = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.length === 0) continue
    if (token.length < 4 || token[2] !== ' ') {
      throw new Error('malformed git status porcelain record')
    }
    const status = token.slice(0, 2)
    const entry = { status, path: token.slice(3) }
    if (status.includes('R') || status.includes('C')) {
      const previousPath = tokens[index + 1]
      if (previousPath === undefined || previousPath.length === 0) {
        throw new Error('malformed git status rename record')
      }
      entry.previousPath = previousPath
      index += 1
    }
    entries.push(entry)
  }
  return entries
}

/**
 * Generated acceptance output is the only dirt allowed around the gate. In
 * particular, source/config/test/script changes are always release-blocking.
 */
export function isGeneratedAcceptancePath(path) {
  if (typeof path !== 'string') return false
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '')
  return (normalized.startsWith(GENERATED_ACCEPTANCE_EVIDENCE_PREFIX)
      && normalized.length > GENERATED_ACCEPTANCE_EVIDENCE_PREFIX.length)
    || GENERATED_ACCEPTANCE_REPORT_PATTERN.test(normalized)
    || GENERATED_TEMP_PATH_PATTERN.test(normalized)
}

function workingTreeInputPaths(entries) {
  if (Array.isArray(entries) === false) return null
  const paths = []
  for (const entry of entries) {
    if (typeof entry === 'string') {
      paths.push(entry)
      continue
    }
    if (entry !== null && typeof entry === 'object') {
      if (typeof entry.path === 'string') paths.push(entry.path)
      if (typeof entry.previousPath === 'string') paths.push(entry.previousPath)
      continue
    }
    return null
  }
  return [...new Set(paths.filter(path => path.length > 0))]
}

export function evaluateWorkingTree(entries) {
  const paths = workingTreeInputPaths(entries)
  if (paths === null) {
    return {
      captured: false,
      clean: false,
      changedPaths: [],
      disallowedPaths: [],
    }
  }
  const disallowedPaths = paths.filter(path => isGeneratedAcceptancePath(path) === false)
  return {
    captured: true,
    clean: disallowedPaths.length === 0,
    changedPaths: paths,
    disallowedPaths,
  }
}

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
    return { errors, report: null, evidence: null, finishedAtMs: null }
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
    const stepByName = new Map(namedSteps.map(step => [step.name.trim(), step]))
    for (const name of REQUIRED_E2E_SCENARIO_NAMES) {
      const required = stepByName.get(name)
      if (required === undefined) {
        errors.push('E2E report is missing mandatory scenario "' + name + '"')
      } else if (String(required.status).toLowerCase() !== 'pass') {
        errors.push('E2E mandatory scenario "' + name + '" did not pass')
      }
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
    if (Number.isSafeInteger(evidence.stepCount) === false) {
      errors.push('E2E evidence requires an integer stepCount')
    } else if (evidence.stepCount < minSteps) {
      errors.push('E2E evidence stepCount is ' + evidence.stepCount + '; minimum is ' + minSteps)
    } else if (Array.isArray(parsed.steps) && evidence.stepCount !== parsed.steps.length) {
      errors.push('E2E evidence stepCount ' + evidence.stepCount
        + ' does not match the ' + parsed.steps.length + ' reported steps')
    }

    const rendererProof = objectValue(evidence.rendererProof)
    if (rendererProof === null) {
      errors.push('E2E evidence requires a rendererProof object')
    } else {
      if (Number.isSafeInteger(rendererProof.browserWindowCount) === false
        || rendererProof.browserWindowCount < 2) {
        errors.push('E2E rendererProof must record at least two real BrowserWindows')
      }
      if (Number.isSafeInteger(rendererProof.rendererProcessCount) === false
        || rendererProof.rendererProcessCount < 2) {
        errors.push('E2E rendererProof must record at least two renderer processes')
      }
      for (const flag of [
        'electronMainPidsDistinct',
        'preloadApiExposed',
        'contextIsolation',
        'sandboxedPreload',
        'nodeIntegrationDisabled',
        'rendererDocumentLoaded',
        'guiElementPresent',
      ]) {
        if (rendererProof[flag] !== true) {
          errors.push('E2E rendererProof requires ' + flag + ' === true')
        }
      }
    }

    const websocket = objectValue(evidence.websocket)
    if (websocket === null) {
      errors.push('E2E evidence requires a websocket object')
    } else {
      if (typeof websocket.serverUrl !== 'string' || /^wss?:\/\//.test(websocket.serverUrl) === false) {
        errors.push('E2E websocket evidence must record a ws:// or wss:// serverUrl')
      }
      if (Number.isSafeInteger(websocket.activeClientCountAtConvergence) === false
        || websocket.activeClientCountAtConvergence < 2) {
        errors.push('E2E websocket evidence must record at least two converged clients')
      }
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
    if (evidence.credentialRuntimeUid !== evidence.uid) {
      errors.push('Docker smoke credentialReadableByRuntime must use the server runtime uid')
    }
    if (evidence.credentialRuntimeMode !== 0o400) {
      errors.push('Docker smoke runtime owner credential mode must be 0400')
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
  const workingTreeBefore = evaluateWorkingTree(options.workingTreeBefore)
  const workingTreeAfter = evaluateWorkingTree(options.workingTreeAfter)
  const workingTreeClean = workingTreeBefore.clean && workingTreeAfter.clean
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
  if (workingTreeBefore.captured === false) {
    errors.push('working tree status before the acceptance gate was not captured')
  } else if (workingTreeBefore.clean === false) {
    errors.push('working tree before the acceptance gate contains non-generated changes: '
      + workingTreeBefore.disallowedPaths.join(', '))
  }
  if (workingTreeAfter.captured === false) {
    errors.push('working tree status after the acceptance gate was not captured')
  } else if (workingTreeAfter.clean === false) {
    errors.push('working tree after the acceptance gate contains non-generated changes: '
      + workingTreeAfter.disallowedPaths.join(', '))
  }
  return {
    ok: commandsPassed && revisionStable && workingTreeClean && e2e.ok && docker.ok && proxy.ok,
    commandsPassed,
    revisionStable,
    workingTreeClean,
    workingTreeBefore,
    workingTreeAfter,
    e2e,
    docker,
    proxy,
    errors,
  }
}

/**
 * Validation primitives for the C12 release gate.
 *
 * The acceptance gate must never infer success from a command's exit status
 * alone. These validators make the gate fail closed when a report is missing,
 * stale, belongs to another revision, omits required evidence, or records a
 * failed/incomplete scenario.
 */
import { createHash } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'

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

/** Stable command identifiers that an authoritative C12 gate summary must contain. */
export const REQUIRED_GATE_COMMANDS = Object.freeze([
  Object.freeze({ id: 'root-typecheck', command: 'npm run typecheck' }),
  Object.freeze({ id: 'root-compatibility-tests', command: 'npm run test:compat' }),
  Object.freeze({ id: 'desktop-build', command: 'npm run build' }),
  Object.freeze({ id: 'android-web-build', command: 'npm run build:android-web' }),
  Object.freeze({ id: 'harmony-web-build', command: 'npm run build:harmony-web' }),
  Object.freeze({ id: 'ios-web-build', command: 'npm run build:ios-web' }),
  Object.freeze({ id: 'server-typecheck', command: 'npm --prefix server run typecheck' }),
  Object.freeze({ id: 'server-tests', command: 'npm --prefix server test' }),
  Object.freeze({ id: 'real-server-two-electron-e2e', command: 'npm run test:e2e' }),
  Object.freeze({ id: 'docker-compose-credential-smoke', command: 'npm run smoke:compose' }),
  Object.freeze({ id: 'docker-image-backup-restore-smoke', command: 'npm run smoke:docker' }),
  Object.freeze({ id: 'tls-wss-proxy-smoke', command: 'npm run smoke:proxy' }),
])
export const REQUIRED_GATE_COMMAND_IDS = Object.freeze(
  REQUIRED_GATE_COMMANDS.map(command => command.id),
)
export const GATE_SUMMARY_SCHEMA_VERSION = 1

/** Proof flags copied verbatim from the E2E report into the gate summary. */
export const GATE_EVIDENCE_E2E_FLAGS = Object.freeze([
  'twoProcesses',
  'realStandaloneServer',
  'realWebSocket',
  'realElectron',
  'realRenderer',
  'rendererCoverage',
  'guiCoverage',
])
/** Boolean renderer proof fields copied verbatim from the E2E report. */
export const GATE_EVIDENCE_RENDERER_PROOF_FLAGS = Object.freeze([
  'windowsHidden',
  'hiddenRendererActive',
  'preloadApiExposed',
  'contextIsolation',
  'sandboxedPreload',
  'nodeIntegrationDisabled',
])
/** The summary only needs to prove a real multi-window run; the E2E report itself enforces 36. */
export const GATE_EVIDENCE_MIN_E2E_STEPS = 18
/** Clock tolerance between a recorded duration and its ISO timestamp span. */
export const GATE_COMMAND_DURATION_TOLERANCE_MS = 2_000

const GATE_REVISION_PATTERN = /^[0-9a-f]{40}$/i
const UUID_TEXT_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const LONG_HEX_TEXT_PATTERN = /[0-9a-f]{32,}/gi

/** A retry count above this means a reconciliation loop, not transport flakiness. */
export const GATE_MAX_COMMAND_RETRIES = 5
const GATE_REPORT_SHA256_PATTERN = /^[0-9a-f]{64}$/
const RAW_UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

function rawUuidPaths(value, path = '$') {
  if (typeof value === 'string') return RAW_UUID_PATTERN.test(value) ? [path] : []
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => rawUuidPaths(item, path + '[' + index + ']'))
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => rawUuidPaths(item, path + '.' + key))
  }
  return []
}

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

/** Only a plain object with at least one own key counts as scenario evidence. */
function nonEmptyPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.keys(value).length > 0
}

/** Normalize a recorded command line so Windows `npm.cmd` still matches `npm`. */
export function normalizeGateCommandLine(value) {
  if (typeof value !== 'string') return null
  return value
    .replace(/\bnpm\.cmd\b/gi, 'npm')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Lowercase sha256 of a report file's exact bytes; this binds reports to the summary. */
export function gateReportSha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Exact client-side message that the server reconciliation path synthesizes for not_applied. */
export const RECONCILIATION_RETRY_MESSAGE = 'the server did not apply the command; retry with a fresh opId'
/** Short settle delay before retrying a command whose frame was lost with the connection. */
export const RECONCILIATION_RETRY_DELAY_MS = 100

/**
 * Only the synthetic `not_available` produced when a command frame was dropped
 * while the connection was closing may be retried with a fresh opId. The
 * documented not_applied semantics are "not applied, retry explicitly"; every
 * other not_available (expired token, business rule) is deterministic and must
 * stay un-retried so the E2E still proves the real rejection.
 */
export function shouldRetryReconciledCommand(result) {
  const item = objectValue(result)
  if (item === null || item.status !== 'rejected') return false
  const error = objectValue(item.error)
  return error !== null
    && error.code === 'not_available'
    && error.message === RECONCILIATION_RETRY_MESSAGE
}

/**
 * Sanitize captured diagnostics before they may enter evidence. UUIDs and any
 * 32+ character hex string are redacted generically, then caller-supplied known
 * secrets are redacted too. `safe` is false when a known secret survived the
 * generic pass (i.e. it is neither UUID- nor long-hex-shaped); callers must
 * then keep the text local (stderr) instead of writing it into the report.
 */
export function sanitizeEvidenceText(text, knownSecrets = []) {
  const raw = typeof text === 'string' ? text : ''
  const generic = raw
    .replace(UUID_TEXT_PATTERN, '[redacted]')
    .replace(LONG_HEX_TEXT_PATTERN, '[redacted]')
  const secrets = (Array.isArray(knownSecrets) ? knownSecrets : [])
    .filter(value => typeof value === 'string' && value.length > 0)
  const knownSecretHits = secrets.filter(value => generic.includes(value)).length
  let sanitized = generic
  for (const value of secrets) sanitized = sanitized.split(value).join('[redacted]')
  return { text: sanitized, safe: knownSecretHits === 0, knownSecretHits }
}

function isSha256Hex(value) {
  return typeof value === 'string' && GATE_REPORT_SHA256_PATTERN.test(value)
}

function sameRevision(value, revision) {
  return typeof value === 'string'
    && typeof revision === 'string'
    && revision.length > 0
    && value.toLowerCase() === revision.toLowerCase()
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

  const uuidPaths = rawUuidPaths(parsed)
  if (uuidPaths.length > 0) {
    errors.push(kind + ' report contains raw UUID identifier(s) at '
      + uuidPaths.join(', ') + '; hash or omit them')
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
      } else if (required.detail === undefined || required.detail === null) {
        errors.push('E2E mandatory scenario "' + name + '" is missing its gate detail')
      } else if (nonEmptyPlainObject(required.detail) === false) {
        errors.push('E2E mandatory scenario "' + name
          + '" must record a non-empty plain-object gate detail')
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

    const commandRetries = objectValue(evidence.commandRetries)
    if (commandRetries === null) {
      errors.push('E2E evidence requires a commandRetries object with total and entries')
    } else {
      if (Number.isSafeInteger(commandRetries.total) === false
        || commandRetries.total < 0
        || commandRetries.total > GATE_MAX_COMMAND_RETRIES) {
        errors.push('E2E evidence commandRetries.total must be an integer between 0 and '
          + GATE_MAX_COMMAND_RETRIES + ' (a higher count indicates a retry storm)')
      }
      if (Array.isArray(commandRetries.entries) === false) {
        errors.push('E2E evidence commandRetries must include an entries array')
      } else if (Number.isSafeInteger(commandRetries.total)
        && commandRetries.entries.length !== commandRetries.total) {
        errors.push('E2E evidence commandRetries.entries length '
          + commandRetries.entries.length + ' does not match total ' + commandRetries.total)
      }
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
        'windowsHidden',
        'hiddenRendererActive',
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

function reportDigestOf(entry) {
  const file = objectValue(entry)
  if (file === null) return null
  const { bytes } = file
  return Buffer.isBuffer(bytes) || typeof bytes === 'string' ? gateReportSha256(bytes) : null
}

function evidenceFlagSnapshot(source, flags) {
  const evidence = objectValue(source)
  const snapshot = {}
  for (const flag of flags) snapshot[flag] = evidence !== null && evidence[flag] === true
  return snapshot
}

/**
 * Snapshot the proof-bearing fields of the three reports plus the sha256 of
 * their exact bytes. Every value is copied from the report (never assumed), so
 * a report that did not prove a flag yields false/null here and fails
 * validateGateSummary. Entries are `{ path, bytes, report }` as read once by
 * the gate, keeping the digest and the parsed values on the same bytes.
 */
export function buildGateEvidenceSnapshot(reports = {}) {
  const e2eFile = objectValue(reports.e2e)
  const dockerFile = objectValue(reports.docker)
  const proxyFile = objectValue(reports.proxy)
  const e2eReport = objectValue(e2eFile?.report) ?? {}
  const e2eEvidence = objectValue(e2eReport.evidence) ?? {}
  const rendererProof = objectValue(e2eEvidence.rendererProof) ?? {}
  const dockerEvidence = objectValue(objectValue(dockerFile?.report)?.evidence) ?? {}
  const proxyEvidence = objectValue(objectValue(proxyFile?.report)?.evidence) ?? {}
  return {
    e2e: {
      reportSha256: reportDigestOf(e2eFile),
      result: typeof e2eReport.result === 'string' ? e2eReport.result : null,
      codeRevision: typeof e2eReport.codeRevision === 'string' ? e2eReport.codeRevision : null,
      stepCount: Number.isSafeInteger(e2eEvidence.stepCount) ? e2eEvidence.stepCount : null,
      commandRetries: Number.isSafeInteger(e2eEvidence.commandRetries?.total)
        ? e2eEvidence.commandRetries.total
        : null,
      flags: evidenceFlagSnapshot(e2eEvidence, GATE_EVIDENCE_E2E_FLAGS),
      rendererProof: {
        browserWindowCount: Number.isSafeInteger(rendererProof.browserWindowCount)
          ? rendererProof.browserWindowCount
          : null,
        rendererProcessCount: Number.isSafeInteger(rendererProof.rendererProcessCount)
          ? rendererProof.rendererProcessCount
          : null,
        windowsHidden: rendererProof.windowsHidden === true,
        hiddenRendererActive: rendererProof.hiddenRendererActive === true,
        preloadApiExposed: rendererProof.preloadApiExposed === true,
        contextIsolation: rendererProof.contextIsolation === true,
        sandboxedPreload: rendererProof.sandboxedPreload === true,
        nodeIntegrationDisabled: rendererProof.nodeIntegrationDisabled === true,
      },
    },
    docker: {
      reportSha256: reportDigestOf(dockerFile),
      result: typeof objectValue(dockerFile?.report)?.result === 'string'
        ? dockerFile.report.result
        : null,
      codeRevision: typeof objectValue(dockerFile?.report)?.codeRevision === 'string'
        ? dockerFile.report.codeRevision
        : null,
      flags: evidenceFlagSnapshot(dockerEvidence, REQUIRED_DOCKER_EVIDENCE_FLAGS),
    },
    proxy: {
      reportSha256: reportDigestOf(proxyFile),
      result: typeof objectValue(proxyFile?.report)?.result === 'string'
        ? proxyFile.report.result
        : null,
      codeRevision: typeof objectValue(proxyFile?.report)?.codeRevision === 'string'
        ? proxyFile.report.codeRevision
        : null,
      flags: evidenceFlagSnapshot(proxyEvidence, REQUIRED_PROXY_EVIDENCE_FLAGS),
    },
  }
}

/**
 * Build the authoritative machine summary from the exact command results and
 * report files the gate validated. The summary carries every mandatory
 * scenario detail and a sha256-bound evidence snapshot, so a renamed scenario
 * or a dropped proof cannot silently pass.
 */
export function buildGateSummary(options = {}) {
  const resultsById = new Map((options.results ?? []).map(result => [result.id, result]))
  const steps = options.steps ?? []
  const commands = steps.map(step => {
    const result = resultsById.get(step.id)
    if (result === undefined) {
      return {
        id: step.id,
        label: step.label,
        command: [step.command, ...step.args].join(' '),
        exitCode: null,
        durationMs: 0,
        startedAt: null,
        finishedAt: null,
        status: 'NOT_RUN',
      }
    }
    return {
      id: step.id,
      label: step.label,
      command: result.command,
      exitCode: result.code,
      durationMs: result.durationMs,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      status: result.code === 0 ? 'PASS' : 'FAIL',
    }
  })
  const stepByName = new Map((options.e2eReport?.steps ?? []).map(step => [step.name, step]))
  const scenarios = REQUIRED_E2E_SCENARIO_NAMES.map(name => {
    const step = stepByName.get(name)
    return {
      name,
      status: typeof step?.status === 'string' ? step.status.toLowerCase() : 'missing',
      durationMs: Number.isFinite(step?.durationMs) ? step.durationMs : null,
      detail: step?.detail ?? null,
    }
  })
  return {
    schemaVersion: GATE_SUMMARY_SCHEMA_VERSION,
    result: options.gateEvaluation?.ok ? 'PASS' : 'FAIL',
    codeRevision: options.revision,
    startedAt: new Date(options.startedAtMs).toISOString(),
    finishedAt: new Date(options.finishedAtMs).toISOString(),
    cleanTree: {
      before: options.gateEvaluation?.workingTreeBefore?.clean === true,
      after: options.gateEvaluation?.workingTreeAfter?.clean === true,
    },
    head: {
      before: options.revision,
      after: options.revisionAfter,
    },
    commands,
    scenarios,
    evidence: buildGateEvidenceSnapshot(options.reports),
  }
}

function validIsoTimestamp(value) {
  if (typeof value !== 'string') return Number.NaN
  return Date.parse(value)
}

/**
 * The summary is only authoritative if it carries the proof the gate observed:
 * digest-bound e2e/docker/proxy reports, passing results at the same revision,
 * every required flag, real multi-window renderer proof and enough E2E steps.
 */
function appendGateEvidenceErrors(errors, evidence, summaryRevision, kind) {
  if (evidence === null) {
    errors.push(kind + ' must include an evidence object binding the e2e, docker and proxy reports')
    return
  }
  const e2e = objectValue(evidence.e2e)
  if (e2e === null) {
    errors.push(kind + ' evidence must include an e2e object')
  } else {
    if (e2e.result !== 'PASS') {
      errors.push(kind + ' evidence.e2e.result must be exactly "PASS" (got '
        + JSON.stringify(e2e.result) + ')')
    }
    if (sameRevision(e2e.codeRevision, summaryRevision) === false) {
      errors.push(kind + ' evidence.e2e.codeRevision ' + JSON.stringify(e2e.codeRevision)
        + ' must equal the summary codeRevision ' + JSON.stringify(summaryRevision))
    }
    const flags = objectValue(e2e.flags)
    if (flags === null) {
      errors.push(kind + ' evidence.e2e must include a flags object')
    } else {
      for (const flag of GATE_EVIDENCE_E2E_FLAGS) {
        if (flags[flag] !== true) errors.push(kind + ' evidence.e2e.flags.' + flag + ' must be true')
      }
    }
    const proof = objectValue(e2e.rendererProof)
    if (proof === null) {
      errors.push(kind + ' evidence.e2e must include a rendererProof object')
    } else {
      for (const count of ['browserWindowCount', 'rendererProcessCount']) {
        if (Number.isSafeInteger(proof[count]) === false || proof[count] < 2) {
          errors.push(kind + ' evidence.e2e.rendererProof.' + count
            + ' must record at least two real BrowserWindows/renderer processes')
        }
      }
      for (const flag of GATE_EVIDENCE_RENDERER_PROOF_FLAGS) {
        if (proof[flag] !== true) {
          errors.push(kind + ' evidence.e2e.rendererProof.' + flag + ' must be true')
        }
      }
    }
    if (Number.isSafeInteger(e2e.stepCount) === false
      || e2e.stepCount < GATE_EVIDENCE_MIN_E2E_STEPS) {
      errors.push(kind + ' evidence.e2e.stepCount must be an integer >= '
        + GATE_EVIDENCE_MIN_E2E_STEPS)
    }
    if (Number.isSafeInteger(e2e.commandRetries) === false || e2e.commandRetries < 0) {
      errors.push(kind + ' evidence.e2e.commandRetries must be an integer retry count')
    } else if (e2e.commandRetries > GATE_MAX_COMMAND_RETRIES) {
      errors.push(kind + ' evidence.e2e.commandRetries ' + e2e.commandRetries
        + ' exceeds ' + GATE_MAX_COMMAND_RETRIES
        + ' (retry storm: reconciliation is looping instead of recovering once)')
    }
    if (isSha256Hex(e2e.reportSha256) === false) {
      errors.push(kind + ' evidence.e2e.reportSha256 must be a 64-character lowercase sha256 digest')
    }
  }
  for (const [key, requiredFlags] of [
    ['docker', REQUIRED_DOCKER_EVIDENCE_FLAGS],
    ['proxy', REQUIRED_PROXY_EVIDENCE_FLAGS],
  ]) {
    const section = objectValue(evidence[key])
    if (section === null) {
      errors.push(kind + ' evidence must include a ' + key + ' object')
      continue
    }
    if (section.result !== 'PASS') {
      errors.push(kind + ' evidence.' + key + '.result must be exactly "PASS" (got '
        + JSON.stringify(section.result) + ')')
    }
    if (sameRevision(section.codeRevision, summaryRevision) === false) {
      errors.push(kind + ' evidence.' + key + '.codeRevision ' + JSON.stringify(section.codeRevision)
        + ' must equal the summary codeRevision ' + JSON.stringify(summaryRevision))
    }
    const flags = objectValue(section.flags)
    if (flags === null) {
      errors.push(kind + ' evidence.' + key + ' must include a flags object')
    } else {
      for (const flag of requiredFlags) {
        if (flags[flag] !== true) {
          errors.push(kind + ' evidence.' + key + '.flags.' + flag + ' must be true')
        }
      }
    }
    if (isSha256Hex(section.reportSha256) === false) {
      errors.push(kind + ' evidence.' + key
        + '.reportSha256 must be a 64-character lowercase sha256 digest')
    }
  }
}

/**
 * Validate the machine-readable gate summary. The markdown report is human
 * convenience only; this summary is authoritative for command completion,
 * revision binding, cleanliness, timestamps and mandatory scenario details.
 */
export function validateGateSummary(summary, options = {}) {
  const errors = []
  const kind = 'Gate summary'
  const nowMs = options.nowMs ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? EVIDENCE_MAX_AGE_MS
  const futureSkewMs = options.futureSkewMs ?? EVIDENCE_FUTURE_SKEW_MS
  const parsed = objectValue(summary)
  if (parsed === null) {
    return validationResult([kind + ' is missing or not a JSON object'])
  }

  const uuidPaths = rawUuidPaths(parsed)
  if (uuidPaths.length > 0) {
    errors.push(kind + ' contains raw UUID identifier(s) at '
      + uuidPaths.join(', ') + '; hash or omit them')
  }

  if (parsed.schemaVersion !== GATE_SUMMARY_SCHEMA_VERSION) {
    errors.push(kind + ' schemaVersion must be ' + GATE_SUMMARY_SCHEMA_VERSION)
  }
  if (parsed.result !== 'PASS') {
    errors.push(kind + ' result must be exactly "PASS" (got ' + JSON.stringify(parsed.result) + ')')
  }
  if (typeof parsed.codeRevision !== 'string' || GATE_REVISION_PATTERN.test(parsed.codeRevision) === false) {
    errors.push(kind + ' must include a 40-character hexadecimal codeRevision')
  } else if (typeof options.currentRevision !== 'string' || options.currentRevision.length === 0) {
    errors.push('current HEAD revision is unavailable for ' + kind + ' comparison')
  } else if (parsed.codeRevision.toLowerCase() !== options.currentRevision.toLowerCase()) {
    errors.push(kind + ' codeRevision ' + parsed.codeRevision
      + ' does not match current HEAD ' + options.currentRevision)
  }

  const startedAtMs = validIsoTimestamp(parsed.startedAt)
  const finishedAtMs = validIsoTimestamp(parsed.finishedAt)
  if (Number.isFinite(startedAtMs) === false) {
    errors.push(kind + ' must include a valid startedAt timestamp')
  }
  if (Number.isFinite(finishedAtMs) === false) {
    errors.push(kind + ' must include a valid finishedAt timestamp')
  } else {
    const ageMs = nowMs - finishedAtMs
    if (ageMs > maxAgeMs) {
      errors.push(kind + ' is stale: finishedAt is older than ' + Math.round(maxAgeMs / 60_000) + ' minutes')
    }
    if (ageMs < -futureSkewMs) {
      errors.push(kind + ' finishedAt is in the future by more than ' + Math.round(futureSkewMs / 60_000) + ' minutes')
    }
    if (Number.isFinite(startedAtMs) && finishedAtMs < startedAtMs) {
      errors.push(kind + ' finishedAt precedes startedAt')
    }
    if (options.notBeforeMs !== undefined && finishedAtMs < options.notBeforeMs) {
      errors.push(kind + ' was not produced by this gate run (finishedAt precedes gate start)')
    }
  }

  const cleanTree = objectValue(parsed.cleanTree)
  if (cleanTree === null) {
    errors.push(kind + ' must include a cleanTree object with before and after')
  } else {
    if (cleanTree.before !== true) errors.push(kind + ' cleanTree.before must be true')
    if (cleanTree.after !== true) errors.push(kind + ' cleanTree.after must be true')
  }

  const head = objectValue(parsed.head)
  if (head === null) {
    errors.push(kind + ' must include a head object with before and after')
  } else {
    for (const key of ['before', 'after']) {
      if (typeof head[key] !== 'string' || GATE_REVISION_PATTERN.test(head[key]) === false) {
        errors.push(kind + ' head.' + key + ' must be a 40-character hexadecimal revision')
      } else if (typeof parsed.codeRevision === 'string'
        && head[key].toLowerCase() !== parsed.codeRevision.toLowerCase()) {
        errors.push(kind + ' head.' + key + ' must equal codeRevision')
      }
    }
    if (typeof head.before === 'string' && typeof head.after === 'string'
      && head.before.toLowerCase() !== head.after.toLowerCase()) {
      errors.push(kind + ' HEAD changed while the acceptance gate was running')
    }
  }

  const commands = Array.isArray(parsed.commands) ? parsed.commands : null
  if (commands === null) {
    errors.push(kind + ' must include a commands array')
  } else {
    const commandById = new Map()
    for (const command of commands) {
      const item = objectValue(command)
      if (item === null || typeof item.id !== 'string' || item.id.length === 0) {
        errors.push(kind + ' commands must each include a non-empty id')
        continue
      }
      if (commandById.has(item.id)) {
        errors.push(kind + ' contains duplicate command id ' + item.id)
        continue
      }
      commandById.set(item.id, item)
    }
    for (const required of REQUIRED_GATE_COMMANDS) {
      const command = commandById.get(required.id)
      if (command === undefined) {
        errors.push(kind + ' is missing required command id ' + required.id)
        continue
      }
      if (command.exitCode !== 0) {
        errors.push(kind + ' command ' + required.id + ' must exit 0 (got '
          + JSON.stringify(command.exitCode) + ')')
      }
      if (Number.isSafeInteger(command.durationMs) === false || command.durationMs < 0) {
        errors.push(kind + ' command ' + required.id + ' must include a non-negative integer durationMs')
      }
      if (typeof command.command !== 'string' || command.command.trim().length === 0) {
        errors.push(kind + ' command ' + required.id + ' must include its command line')
      } else if (normalizeGateCommandLine(command.command) !== normalizeGateCommandLine(required.command)) {
        errors.push(kind + ' command ' + required.id + ' recorded command line '
          + JSON.stringify(command.command) + ' does not match the required command '
          + JSON.stringify(required.command))
      }
      const expectedStatus = command.exitCode === 0 ? 'PASS' : 'FAIL'
      if (command.status !== expectedStatus) {
        errors.push(kind + ' command ' + required.id + ' status ' + JSON.stringify(command.status)
          + ' contradicts exitCode ' + JSON.stringify(command.exitCode)
          + ' (expected ' + expectedStatus + ')')
      }
      const commandStartedMs = validIsoTimestamp(command.startedAt)
      const commandFinishedMs = validIsoTimestamp(command.finishedAt)
      if (Number.isFinite(commandStartedMs) === false) {
        errors.push(kind + ' command ' + required.id + ' must include a valid startedAt timestamp')
      }
      if (Number.isFinite(commandFinishedMs) === false) {
        errors.push(kind + ' command ' + required.id + ' must include a valid finishedAt timestamp')
      }
      if (Number.isFinite(commandStartedMs) && Number.isFinite(commandFinishedMs)
        && commandFinishedMs < commandStartedMs) {
        errors.push(kind + ' command ' + required.id + ' finishedAt precedes startedAt')
      }
      if (Number.isFinite(commandStartedMs) && Number.isFinite(startedAtMs)
        && commandStartedMs < startedAtMs) {
        errors.push(kind + ' command ' + required.id + ' started before the gate summary')
      }
      if (Number.isFinite(commandFinishedMs) && Number.isFinite(finishedAtMs)
        && commandFinishedMs > finishedAtMs) {
        errors.push(kind + ' command ' + required.id + ' finished after the gate summary')
      }
      if (Number.isSafeInteger(command.durationMs)
        && Number.isFinite(commandStartedMs) && Number.isFinite(commandFinishedMs)) {
        const elapsedMs = commandFinishedMs - commandStartedMs
        if (Math.abs(command.durationMs - elapsedMs) > GATE_COMMAND_DURATION_TOLERANCE_MS) {
          errors.push(kind + ' command ' + required.id + ' durationMs ' + command.durationMs
            + ' does not match its ' + elapsedMs + 'ms startedAt/finishedAt span')
        }
      }
    }
    for (const id of commandById.keys()) {
      if (REQUIRED_GATE_COMMAND_IDS.includes(id) === false) {
        errors.push(kind + ' contains unknown command id ' + id)
      }
    }
  }

  const scenarios = Array.isArray(parsed.scenarios) ? parsed.scenarios : null
  if (scenarios === null) {
    errors.push(kind + ' must include a scenarios array covering every mandatory scenario')
  } else {
    const scenarioByName = new Map()
    for (const scenario of scenarios) {
      const item = objectValue(scenario)
      if (item === null || typeof item.name !== 'string' || item.name.trim().length === 0) {
        errors.push(kind + ' scenarios must each include a non-empty name')
        continue
      }
      if (scenarioByName.has(item.name)) {
        errors.push(kind + ' contains duplicate scenario ' + JSON.stringify(item.name))
        continue
      }
      scenarioByName.set(item.name, item)
    }
    for (const name of REQUIRED_E2E_SCENARIO_NAMES) {
      const scenario = scenarioByName.get(name)
      if (scenario === undefined) {
        errors.push(kind + ' is missing mandatory scenario "' + name + '"')
        continue
      }
      if (String(scenario.status).toLowerCase() !== 'pass') {
        errors.push(kind + ' mandatory scenario "' + name + '" did not pass')
      }
      if (Number.isFinite(scenario.durationMs) === false || scenario.durationMs < 0) {
        errors.push(kind + ' mandatory scenario "' + name + '" has an invalid durationMs')
      }
      if (scenario.detail === undefined || scenario.detail === null) {
        errors.push(kind + ' mandatory scenario "' + name + '" is missing its detail')
      } else if (nonEmptyPlainObject(scenario.detail) === false) {
        errors.push(kind + ' mandatory scenario "' + name
          + '" must record a non-empty plain-object detail')
      }
    }
    for (const name of scenarioByName.keys()) {
      if (REQUIRED_E2E_SCENARIO_NAMES.includes(name) === false) {
        errors.push(kind + ' contains unknown scenario ' + JSON.stringify(name))
      }
    }
  }

  appendGateEvidenceErrors(
    errors,
    objectValue(parsed.evidence),
    typeof parsed.codeRevision === 'string' ? parsed.codeRevision : '',
    kind,
  )

  return {
    ok: errors.length === 0,
    errors,
    commandCount: commands?.length ?? 0,
    scenarioCount: scenarios?.length ?? 0,
  }
}

/**
 * A summary scenario only counts as evidence when it still equals the step in
 * the digest-bound E2E report. Without this, rewriting only
 * gate-summary.json scenarios[].detail would fabricate selected-scenario proof.
 */
function appendE2EScenarioBindingErrors(errors, summary, report) {
  const scenarios = Array.isArray(summary.scenarios) ? summary.scenarios : []
  const steps = Array.isArray(report.steps) ? report.steps : []
  const stepByName = new Map()
  for (const step of steps) {
    const item = objectValue(step)
    if (item !== null && typeof item.name === 'string') stepByName.set(item.name, item)
  }
  for (const scenario of scenarios) {
    const item = objectValue(scenario)
    if (item === null || typeof item.name !== 'string') continue
    const step = stepByName.get(item.name)
    if (step === undefined) {
      errors.push('E2E report is missing the step for gate-summary scenario '
        + JSON.stringify(item.name))
      continue
    }
    const expected = {
      status: typeof step.status === 'string' ? step.status.toLowerCase() : 'missing',
      durationMs: Number.isFinite(step.durationMs) ? step.durationMs : null,
      detail: step.detail ?? null,
    }
    const recorded = {
      status: typeof item.status === 'string' ? item.status.toLowerCase() : item.status,
      durationMs: item.durationMs ?? null,
      detail: item.detail ?? null,
    }
    if (isDeepStrictEqual(expected, recorded) === false) {
      errors.push('Gate summary scenario ' + JSON.stringify(item.name)
        + ' does not match the digest-bound E2E report step')
    }
  }
}

const GATE_EVIDENCE_REPORT_LABELS = Object.freeze({
  e2e: 'E2E',
  docker: 'Docker smoke',
  proxy: 'TLS/WSS proxy smoke',
})

/**
 * Bind a gate summary to the exact sub-report files it claims. The CLI reads
 * the in-repository default reports once and passes `{ path, bytes }` per kind;
 * the summary is rejected when a report is missing, its bytes do not hash to
 * the recorded sha256, or its result/revision disagree with the summary. The
 * summary snapshot must also equal the values recomputed from those bytes, so
 * hard-coded true flags cannot be paired with a failing report.
 */
export function validateGateEvidenceFiles(summary, files = {}) {
  const parsed = objectValue(summary)
  if (parsed === null) return validationResult(['Gate summary is missing or not a JSON object'])
  const errors = []
  const evidence = objectValue(parsed.evidence)
  const summaryRevision = typeof parsed.codeRevision === 'string' ? parsed.codeRevision : ''
  for (const kind of ['e2e', 'docker', 'proxy']) {
    const label = GATE_EVIDENCE_REPORT_LABELS[kind]
    const file = objectValue(objectValue(files)?.[kind])
    const path = typeof file?.path === 'string' ? file.path : '(unknown path)'
    const bytes = file?.bytes
    if ((Buffer.isBuffer(bytes) || typeof bytes === 'string') === false) {
      errors.push(label + ' report file is missing: ' + path)
      continue
    }
    const digest = gateReportSha256(bytes)
    const recordedSection = objectValue(objectValue(evidence)?.[kind])
    const recordedDigest = recordedSection?.reportSha256 ?? null
    if (digest !== recordedDigest) {
      errors.push(label + ' report sha256 digest ' + digest + ' at ' + path
        + ' does not match gate-summary evidence.' + kind + '.reportSha256 '
        + JSON.stringify(recordedDigest))
    }
    let report
    try {
      report = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes)
    } catch (error) {
      errors.push(label + ' report at ' + path + ' is not valid JSON: '
        + (error instanceof Error ? error.message : String(error)))
      continue
    }
    const parsedReport = objectValue(report)
    if (parsedReport === null) {
      errors.push(label + ' report at ' + path + ' must be a JSON object')
      continue
    }
    if (parsedReport.result !== 'PASS') {
      errors.push(label + ' report at ' + path + ' result must be exactly "PASS" (got '
        + JSON.stringify(parsedReport.result) + ')')
    }
    if (sameRevision(parsedReport.codeRevision, summaryRevision) === false) {
      errors.push(label + ' report codeRevision ' + JSON.stringify(parsedReport.codeRevision)
        + ' does not match gate summary codeRevision ' + JSON.stringify(summaryRevision))
    }
    if (recordedSection !== null) {
      const recomputed = buildGateEvidenceSnapshot({
        [kind]: { path, bytes, report: parsedReport },
      })[kind]
      const recorded = { ...recordedSection }
      delete recomputed.reportSha256
      delete recorded.reportSha256
      if (isDeepStrictEqual(recomputed, recorded) === false) {
        errors.push(label + ' report evidence does not match the values recorded in '
          + 'gate-summary evidence.' + kind + ' (' + path + ')')
      }
    }
    // Binding is not enough: the CLI must stand on its own with the same depth
    // as the in-gate evaluation, otherwise a digest-consistent but invalid
    // report (e.g. journalMode "delete", 18-step E2E) would pass the gate CLI.
    const deepValidation = kind === 'e2e'
      ? validateE2EReport(parsedReport, { currentRevision: summaryRevision })
      : kind === 'docker'
        ? validateDockerSmokeReport(parsedReport, { currentRevision: summaryRevision })
        : validateProxySmokeReport(parsedReport, { currentRevision: summaryRevision })
    for (const error of deepValidation.errors) {
      errors.push(label + ' report validation: ' + error)
    }
    if (kind === 'e2e') appendE2EScenarioBindingErrors(errors, parsed, parsedReport)
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

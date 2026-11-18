import assert from 'node:assert/strict'
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  buildGateEvidenceSnapshot,
  buildGateSummary,
  cleanEvidenceDirectory,
  evaluateAcceptanceGate,
  evaluateWorkingTree,
  parseGitStatusPorcelain,
  REQUIRED_DOCKER_EVIDENCE_FLAGS,
  REQUIRED_E2E_SCENARIO_NAMES,
  REQUIRED_GATE_COMMANDS,
  REQUIRED_PROXY_EVIDENCE_FLAGS,
  validateDockerSmokeReport,
  validateE2EReport,
  validateGateSummary,
  validateProxySmokeReport,
} from '../lib/acceptance-evidence.mjs'

const NOW = Date.parse('2026-10-22T21:00:00.000Z')
const REV = 'a'.repeat(40)
const startedAt = new Date(NOW - 120_000).toISOString()
const finishedAt = new Date(NOW - 1_000).toISOString()
const GATE_E2E_FLAGS = [
  'twoProcesses',
  'realStandaloneServer',
  'realWebSocket',
  'realElectron',
  'realRenderer',
  'rendererCoverage',
  'guiCoverage',
]

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function e2eSteps(count = 36) {
  const required = REQUIRED_E2E_SCENARIO_NAMES.map((name, index) => ({
    name,
    status: 'pass',
    durationMs: index + 1,
    detail: { requiredIndex: index, projectionHash: String(index).padStart(64, '0') },
  }))
  const generated = Array.from({ length: Math.max(0, count - required.length) }, (_, index) => ({
    name: 'scenario-' + String(index + 1),
    status: 'pass',
    durationMs: required.length + index + 1,
    detail: { generated: true },
  }))
  return [...required, ...generated].slice(0, count)
}

function e2eReport() {
  return {
    result: 'PASS',
    codeRevision: REV,
    startedAt,
    finishedAt,
    steps: e2eSteps(),
    evidence: {
      twoProcesses: true,
      realStandaloneServer: true,
      realWebSocket: true,
      realElectron: true,
      realRenderer: true,
      rendererCoverage: true,
      guiCoverage: true,
      competingActionsCovered: true,
      sessionTokenAbuseCovered: true,
      freshHostPortableImportCovered: true,
      connectedCoverageReopenCovered: true,
      startupCrashRepairCovered: true,
      deterministicRestartCovered: true,
      revokedReconnectCovered: true,
      feedLatencyP95Covered: true,
      timedServerDeadlineCovered: true,
      advanceWhileEmptyZeroClientCovered: true,
      onlineTimeSigninSplitCovered: true,
      localAuthorityHandoffCovered: true,
      survivorRestartNoDuplicateCovered: true,
      advanceWhileEmptyRandomReconnectCovered: true,
      rendererMutationBlockedCovered: true,
      secretBoundaryAuditCovered: true,
      answerKeysAbsent: true,
      timedWorkBothRenderersCovered: true,
      sessionGradingTaskRewardExactCovered: true,
      answerKeyServerSideGradingCovered: true,
      restartEngineStatePreservedCovered: true,
      portableImportEngineStatePreservedCovered: true,
      noDuplicateCatchUpCovered: true,
      stepCount: 36,
      rendererProof: {
        electronMainPidsDistinct: true,
        browserWindowCount: 2,
        rendererProcessCount: 2,
        preloadApiExposed: true,
        contextIsolation: true,
        sandboxedPreload: true,
        nodeIntegrationDisabled: true,
        rendererDocumentLoaded: true,
        guiElementPresent: true,
        windowsHidden: true,
        backgroundThrottlingDisabled: true,
      },
      websocket: {
        serverUrl: 'ws://127.0.0.1:1234/v1/sync',
        activeClientCountAtConvergence: 2,
      },
    },
  }
}

function dockerReport() {
  return {
    result: 'PASS',
    codeRevision: REV,
    startedAt,
    finishedAt,
    evidence: {
      imageBuilt: true,
      containerStarted: true,
      readyzReady: true,
      journalMode: 'wal',
      synchronous: 'full',
      nonRoot: true,
      uid: 1000,
      ownerAdminCredentialHashed: true,
      credentialReadableByRuntime: true,
      credentialRuntimeUid: 1000,
      credentialRuntimeMode: 0o400,
      backupCreated: true,
      backupContentAsserted: true,
      restoreSucceeded: true,
      restoreContentMatched: true,
      postRestoreReadyz: true,
      teardown: true,
    },
  }
}

function proxyReport() {
  return {
    result: 'PASS',
    codeRevision: REV,
    startedAt,
    finishedAt,
    evidence: {
      tlsTerminated: true,
      nginxProxy: true,
      webSocketUpgrade: true,
      authenticatedOverWss: true,
      syncAliasUpgrade: true,
      syncAliasAuthenticated: true,
      healthRoute: true,
      healthzRoute: true,
      readyzRoute: true,
      v1SyncRoute: true,
      syncRoute: true,
    },
  }
}

function summaryEvidence() {
  return {
    e2e: {
      reportSha256: 'e'.repeat(64),
      result: 'PASS',
      codeRevision: REV,
      stepCount: 36,
      flags: Object.fromEntries(GATE_E2E_FLAGS.map(flag => [flag, true])),
      rendererProof: {
        browserWindowCount: 2,
        rendererProcessCount: 2,
        windowsHidden: true,
        backgroundThrottlingDisabled: true,
        preloadApiExposed: true,
        contextIsolation: true,
        sandboxedPreload: true,
        nodeIntegrationDisabled: true,
      },
    },
    docker: {
      reportSha256: 'd'.repeat(64),
      result: 'PASS',
      codeRevision: REV,
      flags: Object.fromEntries(REQUIRED_DOCKER_EVIDENCE_FLAGS.map(flag => [flag, true])),
    },
    proxy: {
      reportSha256: 'f'.repeat(64),
      result: 'PASS',
      codeRevision: REV,
      flags: Object.fromEntries(REQUIRED_PROXY_EVIDENCE_FLAGS.map(flag => [flag, true])),
    },
  }
}

function gateSummary() {
  const commandStartMs = NOW - 100_000
  return {
    schemaVersion: 1,
    result: 'PASS',
    codeRevision: REV,
    startedAt: startedAt,
    finishedAt: finishedAt,
    cleanTree: { before: true, after: true },
    head: { before: REV, after: REV },
    commands: REQUIRED_GATE_COMMANDS.map((required, index) => ({
      id: required.id,
      label: required.id,
      command: required.command,
      exitCode: 0,
      durationMs: 500,
      startedAt: new Date(commandStartMs + index * 1_000).toISOString(),
      finishedAt: new Date(commandStartMs + index * 1_000 + 500).toISOString(),
      status: 'PASS',
    })),
    scenarios: REQUIRED_E2E_SCENARIO_NAMES.map((name, index) => ({
      name,
      status: 'pass',
      durationMs: index + 1,
      detail: { requiredIndex: index },
    })),
    evidence: summaryEvidence(),
  }
}

const options = { currentRevision: REV, nowMs: NOW }

test('valid fresh E2E evidence passes all fail-closed checks', () => {
  assert.deepEqual(validateE2EReport(e2eReport(), options), { ok: true, errors: [] })
})

test('E2E evidence rejects missing, failed, stale, wrong-revision and incomplete reports', () => {
  const cases = [
    ['missing report', () => null, /missing/],
    ['lowercase result', () => ({ ...e2eReport(), result: 'pass' }), /exactly "PASS"/],
    ['failed result', () => ({ ...e2eReport(), result: 'FAIL' }), /exactly "PASS"/],
    ['wrong revision', () => ({ ...e2eReport(), codeRevision: 'b'.repeat(40) }), /does not match current HEAD/],
    ['missing finishedAt', () => ({ ...e2eReport(), finishedAt: undefined }), /valid finishedAt/],
    ['stale finishedAt', () => ({ ...e2eReport(), finishedAt: new Date(NOW - 31 * 60_000).toISOString() }), /stale/],
    ['future finishedAt', () => ({ ...e2eReport(), finishedAt: new Date(NOW + 3 * 60_000).toISOString() }), /future/],
    ['too few steps', () => ({ ...e2eReport(), steps: e2eSteps(35) }), /minimum is 36/],
    ['duplicate step names', () => {
      const report = e2eReport()
      report.steps = Array.from({ length: 36 }, () => ({ name: 'same', status: 'pass', durationMs: 1 }))
      return report
    }, /unique named steps/],
    ['missing mandatory scenario', () => {
      const report = e2eReport()
      report.steps[0].name = 'a different passing scenario'
      return report
    }, /missing mandatory scenario/],
    ['missing survivor restart scenario', () => {
      const report = e2eReport()
      const index = report.steps.findIndex(step => step.name.includes('renderer kill survivor'))
      assert.ok(index >= 0)
      report.steps[index] = { ...report.steps[index], name: 'a different still-passing scenario' }
      return report
    }, /missing mandatory scenario "renderer kill survivor/],
    ['missing random reconnect scenario', () => {
      const report = e2eReport()
      const index = report.steps.findIndex(step => step.name.includes('deterministic random events exactly once'))
      assert.ok(index >= 0)
      report.steps[index] = { ...report.steps[index], name: 'another different passing scenario' }
      return report
    }, /missing mandatory scenario "advanceWhileEmpty true zero-client reconnect/],
    ['missing renderer mutation scenario', () => {
      const report = e2eReport()
      const index = report.steps.findIndex(step => step.name.includes('legacy SavePatch cannot change'))
      assert.ok(index >= 0)
      report.steps[index] = { ...report.steps[index], name: 'yet another passing scenario' }
      return report
    }, /missing mandatory scenario "renderer direct mutation and legacy SavePatch/],
    ['missing secret boundary scenario', () => {
      const report = e2eReport()
      const index = report.steps.findIndex(step => step.name.includes('exclude never-upload secrets'))
      assert.ok(index >= 0)
      report.steps[index] = { ...report.steps[index], name: 'the last different passing scenario' }
      return report
    }, /missing mandatory scenario "server SQLite device fields logs and projections/],
    ['mandatory scenario missing selected detail', () => {
      const report = e2eReport()
      delete report.steps[0].detail
      return report
    }, /missing its gate detail/],
    ['mandatory scenario empty detail object', () => {
      const report = e2eReport()
      report.steps[0].detail = {}
      return report
    }, /non-empty plain-object gate detail/],
    ['mandatory scenario array detail', () => {
      const report = e2eReport()
      report.steps[1].detail = ['requiredIndex']
      return report
    }, /non-empty plain-object gate detail/],
    ['mandatory scenario string detail', () => {
      const report = e2eReport()
      report.steps[2].detail = 'looks like evidence'
      return report
    }, /non-empty plain-object gate detail/],
    ['failed step', () => {
      const report = e2eReport()
      report.steps[4].status = 'fail'
      return report
    }, /not pass/],
    ['missing two-process evidence', () => {
      const report = e2eReport()
      report.evidence.twoProcesses = false
      return report
    }, /twoProcesses/],
    ['missing real WebSocket evidence', () => {
      const report = e2eReport()
      delete report.evidence.realWebSocket
      return report
    }, /realWebSocket/],
    ['missing mandatory scenario flag', () => {
      const report = e2eReport()
      report.evidence.sessionTokenAbuseCovered = false
      return report
    }, /sessionTokenAbuseCovered/],
    ['survivor restart evidence not proven', () => {
      const report = e2eReport()
      delete report.evidence.survivorRestartNoDuplicateCovered
      return report
    }, /survivorRestartNoDuplicateCovered/],
    ['random reconnect evidence not proven', () => {
      const report = e2eReport()
      report.evidence.advanceWhileEmptyRandomReconnectCovered = false
      return report
    }, /advanceWhileEmptyRandomReconnectCovered/],
    ['renderer mutation evidence not proven', () => {
      const report = e2eReport()
      delete report.evidence.rendererMutationBlockedCovered
      return report
    }, /rendererMutationBlockedCovered/],
    ['secret boundary evidence not proven', () => {
      const report = e2eReport()
      report.evidence.secretBoundaryAuditCovered = false
      return report
    }, /secretBoundaryAuditCovered/],
    ['answer-key hygiene not proven', () => {
      const report = e2eReport()
      delete report.evidence.answerKeysAbsent
      return report
    }, /answerKeysAbsent/],
    ['timed two-renderer evidence not proven', () => {
      const report = e2eReport()
      report.evidence.timedWorkBothRenderersCovered = false
      return report
    }, /timedWorkBothRenderersCovered/],
    ['grading evidence not proven', () => {
      const report = e2eReport()
      delete report.evidence.sessionGradingTaskRewardExactCovered
      return report
    }, /sessionGradingTaskRewardExactCovered/],
    ['restart engine preservation not proven', () => {
      const report = e2eReport()
      report.evidence.restartEngineStatePreservedCovered = false
      return report
    }, /restartEngineStatePreservedCovered/],
    ['portable import engine preservation not proven', () => {
      const report = e2eReport()
      delete report.evidence.portableImportEngineStatePreservedCovered
      return report
    }, /portableImportEngineStatePreservedCovered/],
    ['no duplicate catch-up not proven', () => {
      const report = e2eReport()
      report.evidence.noDuplicateCatchUpCovered = false
      return report
    }, /noDuplicateCatchUpCovered/],
    ['missing real Electron evidence', () => {
      const report = e2eReport()
      delete report.evidence.realElectron
      return report
    }, /realElectron/],
    ['missing real renderer evidence', () => {
      const report = e2eReport()
      report.evidence.realRenderer = false
      return report
    }, /realRenderer/],
    ['unproven renderer coverage claim', () => {
      const report = e2eReport()
      report.evidence.rendererCoverage = false
      return report
    }, /rendererCoverage/],
    ['unproven GUI coverage claim', () => {
      const report = e2eReport()
      report.evidence.guiCoverage = false
      return report
    }, /guiCoverage/],
    ['missing BrowserWindow/preload proof', () => {
      const report = e2eReport()
      delete report.evidence.rendererProof
      return report
    }, /rendererProof object/],
    ['only one BrowserWindow', () => {
      const report = e2eReport()
      report.evidence.rendererProof.browserWindowCount = 1
      return report
    }, /two real BrowserWindows/],
    ['missing preload API proof', () => {
      const report = e2eReport()
      report.evidence.rendererProof.preloadApiExposed = false
      return report
    }, /preloadApiExposed/],
    ['hidden-window proof absent', () => {
      const report = e2eReport()
      delete report.evidence.rendererProof.windowsHidden
      return report
    }, /windowsHidden/],
    ['visible windows cannot be accepted', () => {
      const report = e2eReport()
      report.evidence.rendererProof.windowsHidden = false
      return report
    }, /windowsHidden/],
    ['hidden windows must prove throttling stays disabled', () => {
      const report = e2eReport()
      report.evidence.rendererProof.backgroundThrottlingDisabled = false
      return report
    }, /backgroundThrottlingDisabled/],
    ['unthrottled proof absent', () => {
      const report = e2eReport()
      delete report.evidence.rendererProof.backgroundThrottlingDisabled
      return report
    }, /backgroundThrottlingDisabled/],
    ['stepCount mismatch', () => {
      const report = e2eReport()
      report.evidence.stepCount = 35
      return report
    }, /stepCount/],
    ['websocket proof below two clients', () => {
      const report = e2eReport()
      report.evidence.websocket.activeClientCountAtConvergence = 1
      return report
    }, /two converged clients/],
  ]
  for (const [name, build, pattern] of cases) {
    const result = validateE2EReport(build(), options)
    assert.equal(result.ok, false, name)
    assert.match(result.errors.join('\n'), pattern, name)
  }
})

function countOccurrences(source, needle) {
  return source.split(needle).length - 1
}

const HIDDEN_THROTTLING_PREFERENCE = '...(hidden ? { backgroundThrottling: false } : {})'

test('E2E launchers hide windows by default and hidden-mode rendering preconditions are asserted', async () => {
  const repoFile = relative => readFile(fileURLToPath(new URL('../../' + relative, import.meta.url)), 'utf8')
  const rendererSource = await repoFile('scripts/e2e/renderer-e2e.mjs')
  assert.ok(rendererSource.includes('QQPET_E2E_HIDE_WINDOWS'),
    'renderer launcher must pass the hidden-window flag')
  assert.ok(rendererSource.includes("QQPET_E2E_SHOW_WINDOWS === '1' ? '0' : '1'"),
    'renderer launcher must hide windows unless QQPET_E2E_SHOW_WINDOWS=1')
  assert.ok(rendererSource.includes('...WINDOWS_ENV'),
    'renderer launcher must merge the hidden-window environment into every Electron launch')
  // The main-process harness opens no BrowserWindow/renderer; injecting window
  // flags there was dead code that made the launcher list look like GUI cover.
  const harnessSource = await repoFile('scripts/e2e/run-e2e.mjs')
  assert.equal(harnessSource.includes('WINDOWS_ENV'), false,
    'run-e2e must not inject window flags into a BrowserWindow-less harness')
  assert.equal(harnessSource.includes('QQPET_E2E_HIDE_WINDOWS'), false,
    'run-e2e must not claim hidden-window rendering coverage')

  const windowSource = await repoFile('src/main/window.ts')
  assert.ok(windowSource.includes('export function e2eWindowsHidden()'),
    'main must export the hidden-window predicate')
  assert.equal(countOccurrences(windowSource, HIDDEN_THROTTLING_PREFERENCE), 2,
    'pet and game windows must disable background throttling only while hidden')
  assert.equal(countOccurrences(windowSource, 'backgroundThrottling: false'), 2,
    'backgroundThrottling: false must never be unconditional')

  const firstRunSource = await repoFile('src/main/first-run.ts')
  assert.ok(firstRunSource.includes('const hidden = e2eWindowsHidden()'),
    'first-run must honor the hidden-window mode once')
  assert.equal(countOccurrences(firstRunSource, HIDDEN_THROTTLING_PREFERENCE), 1,
    'first-run must disable background throttling only while hidden')
  assert.equal(countOccurrences(firstRunSource, 'backgroundThrottling: false'), 1,
    'first-run backgroundThrottling: false must never be unconditional')
  assert.ok(firstRunSource.includes('if (!hidden) win.show()'),
    'first-run must not show windows while hidden')
})

test('hidden-window mode guards every programmatic focus and records the uncovered show path', async () => {
  const repoFile = relative => readFile(fileURLToPath(new URL('../../' + relative, import.meta.url)), 'utf8')
  const indexSource = await repoFile('src/main/index.ts')
  assert.match(indexSource, /import \{[^}]*\be2eWindowsHidden\b[^}]*\} from '\.\/window'/,
    'index must import the hidden-window predicate from ./window')
  assert.equal(countOccurrences(indexSource, 'win.focus()'), 2,
    'the tray click and IPC.setFocusable are the only programmatic focus sites')
  assert.equal(countOccurrences(indexSource, 'if (!e2eWindowsHidden()) win.focus()'), 2,
    'neither focus site may present a hidden E2E window')

  const rendererSource = await repoFile('scripts/e2e/renderer-e2e.mjs')
  assert.ok(rendererSource.includes('backgroundThrottling: preferences.backgroundThrottling'),
    'mainProof must record the effective backgroundThrottling preference per window')
  assert.ok(rendererSource.includes(
    'backgroundThrottlingDisabled: allWindows.every(window => window.backgroundThrottling === false)'),
    'renderer proof must record the unthrottled hidden-window precondition')
  assert.match(rendererSource, /residualGap: \[/,
    'the honest residual gaps must enter the E2E evidence JSON')
  assert.ok(rendererSource.includes('ready-to-show/showInactive'),
    'residual gaps must disclose that hidden runs never exercise the production show path')
  assert.ok(rendererSource.includes('not covered by this hidden-window run'),
    'the show-path gap must be stated as uncovered')
})

test('Docker smoke evidence requires boot, WAL/FULL, non-root and backup/restore content assertions', () => {
  assert.deepEqual(validateDockerSmokeReport(dockerReport(), options), { ok: true, errors: [] })
  const cases = [
    ['missing image build', report => { report.evidence.imageBuilt = false }, /imageBuilt/],
    ['wrong journal mode', report => { report.evidence.journalMode = 'delete' }, /journalMode/],
    ['not synchronous full', report => { report.evidence.synchronous = 'normal' }, /synchronous/],
    ['root uid', report => { report.evidence.uid = 0 }, /uid/],
    ['unhashed owner credential', report => { report.evidence.ownerAdminCredentialHashed = false }, /ownerAdminCredentialHashed/],
    ['unreadable runtime credential', report => { report.evidence.credentialReadableByRuntime = false }, /credentialReadableByRuntime/],
    ['credential read by the wrong uid', report => { report.evidence.credentialRuntimeUid = 1001 }, /runtime uid/],
    ['credential readable through group/world bits', report => { report.evidence.credentialRuntimeMode = 0o644 }, /mode must be 0400/],
    ['raw owner device UUID', report => {
      report.evidence.ownerAdminDeviceId = 'ed7e7711-849c-4238-8b19-ac23dbf271a8'
    }, /raw UUID/],
    ['missing backup assertion', report => { report.evidence.backupContentAsserted = false }, /backupContentAsserted/],
    ['restore content mismatch', report => { report.evidence.restoreContentMatched = false }, /restoreContentMatched/],
    ['tea down not proven', report => { report.evidence.teardown = false }, /teardown/],
  ]
  for (const [name, mutate, pattern] of cases) {
    const report = dockerReport()
    mutate(report)
    const result = validateDockerSmokeReport(report, options)
    assert.equal(result.ok, false, name)
    assert.match(result.errors.join('\n'), pattern, name)
  }
})

test('TLS/WSS proxy evidence requires every documented Nginx route and authenticated upgrade', () => {
  assert.deepEqual(validateProxySmokeReport(proxyReport(), options), { ok: true, errors: [] })
  const cases = [
    ['health alias', report => { report.evidence.healthRoute = false }, /healthRoute/],
    ['sync alias upgrade', report => { report.evidence.syncAliasUpgrade = false }, /syncAliasUpgrade/],
    ['sync alias authentication', report => { report.evidence.syncAliasAuthenticated = false }, /syncAliasAuthenticated/],
    ['v1 sync route', report => { report.evidence.v1SyncRoute = false }, /v1SyncRoute/],
    ['raw sync alias device UUID', report => {
      report.evidence.syncAliasDeviceId = 'f5c5e19e-17cf-44bd-b3ef-b9502bdbc32c'
    }, /raw UUID/],
  ]
  for (const [name, mutate, pattern] of cases) {
    const report = proxyReport()
    mutate(report)
    const result = validateProxySmokeReport(report, options)
    assert.equal(result.ok, false, name)
    assert.match(result.errors.join('\n'), pattern, name)
  }
})

test('machine-readable gate summary is authoritative for commands, revisions and scenarios', () => {
  const summaryOptions = { currentRevision: REV, nowMs: NOW, notBeforeMs: NOW - 180_000 }
  const valid = validateGateSummary(gateSummary(), summaryOptions)
  assert.equal(valid.ok, true, valid.errors.join('\n'))
  assert.equal(valid.commandCount, REQUIRED_GATE_COMMANDS.length)
  assert.equal(valid.scenarioCount, REQUIRED_E2E_SCENARIO_NAMES.length)

  // Canonical command lines stay accepted across platforms and whitespace styles.
  const normalized = gateSummary()
  const serverTypecheck = normalized.commands.find(command => command.id === 'server-typecheck')
  serverTypecheck.command = '  npm.cmd   --prefix   server run typecheck '
  const normalizedResult = validateGateSummary(normalized, summaryOptions)
  assert.equal(normalizedResult.ok, true, normalizedResult.errors.join('\n'))

  // An instant command is allowed only while its timestamp span agrees with it.
  const instant = gateSummary()
  instant.commands[0].finishedAt = instant.commands[0].startedAt
  instant.commands[0].durationMs = 0
  const instantResult = validateGateSummary(instant, summaryOptions)
  assert.equal(instantResult.ok, true, instantResult.errors.join('\n'))

  const cases = [
    ['failed gate result', summary => { summary.result = 'FAIL' }, /result must be exactly "PASS"/],
    ['wrong tested revision', summary => { summary.codeRevision = 'b'.repeat(40) }, /does not match current HEAD/],
    ['stale summary', summary => {
      summary.finishedAt = new Date(NOW - 31 * 60_000).toISOString()
    }, /stale/],
    ['dirty tree before', summary => { summary.cleanTree.before = false }, /cleanTree.before/],
    ['dirty tree after', summary => { summary.cleanTree.after = false }, /cleanTree.after/],
    ['changed head', summary => { summary.head.after = 'b'.repeat(40) }, /HEAD changed/],
    ['missing required command', summary => {
      summary.commands = summary.commands.filter(command => command.id !== 'server-tests')
    }, /missing required command id server-tests/],
    ['failed internal command', summary => { summary.commands[3].exitCode = 1 }, /must exit 0/],
    ['missing command duration', summary => { delete summary.commands[4].durationMs }, /durationMs/],
    ['missing command timestamp', summary => { delete summary.commands[5].startedAt }, /startedAt/],
    ['spoofed command line', summary => { summary.commands[0].command = 'echo spoofed' },
      /does not match the required command/],
    ['status contradicts a successful exit code', summary => {
      summary.commands[0].status = 'FAIL'
    }, /status .* contradicts exitCode/],
    ['status contradicts a failing exit code', summary => { summary.commands[6].exitCode = 1 },
      /status .* contradicts exitCode/],
    ['duration disagrees with its timestamps', summary => {
      summary.commands[1].durationMs = 60_000
    }, /durationMs .* does not match its .*span/],
    ['missing evidence binding', summary => { delete summary.evidence }, /evidence object/],
    ['e2e evidence result not passing', summary => { summary.evidence.e2e.result = 'FAIL' },
      /evidence\.e2e\.result/],
    ['e2e evidence revision mismatch', summary => {
      summary.evidence.e2e.codeRevision = 'b'.repeat(40)
    }, /evidence\.e2e\.codeRevision/],
    ['e2e evidence flag not proven', summary => {
      summary.evidence.e2e.flags.twoProcesses = false
    }, /evidence\.e2e\.flags\.twoProcesses/],
    ['e2e evidence step count below the floor', summary => {
      summary.evidence.e2e.stepCount = 17
    }, /evidence\.e2e\.stepCount/],
    ['e2e evidence digest malformed', summary => {
      summary.evidence.e2e.reportSha256 = 'not-a-sha256'
    }, /evidence\.e2e\.reportSha256/],
    ['e2e evidence windows not proven hidden', summary => {
      summary.evidence.e2e.rendererProof.windowsHidden = false
    }, /rendererProof\.windowsHidden/],
    ['e2e evidence background throttling not disabled', summary => {
      summary.evidence.e2e.rendererProof.backgroundThrottlingDisabled = false
    }, /rendererProof\.backgroundThrottlingDisabled/],
    ['e2e evidence renderer process proof too weak', summary => {
      summary.evidence.e2e.rendererProof.rendererProcessCount = 1
    }, /rendererProof\.rendererProcessCount/],
    ['docker evidence result not passing', summary => { summary.evidence.docker.result = 'FAIL' },
      /evidence\.docker\.result/],
    ['docker evidence revision mismatch', summary => {
      summary.evidence.docker.codeRevision = 'b'.repeat(40)
    }, /evidence\.docker\.codeRevision/],
    ['docker evidence flag not proven', summary => {
      summary.evidence.docker.flags.backupContentAsserted = false
    }, /evidence\.docker\.flags\.backupContentAsserted/],
    ['docker evidence digest malformed', summary => {
      summary.evidence.docker.reportSha256 = 'f'.repeat(63)
    }, /evidence\.docker\.reportSha256/],
    ['proxy evidence flag not proven', summary => {
      summary.evidence.proxy.flags.syncAliasAuthenticated = false
    }, /evidence\.proxy\.flags\.syncAliasAuthenticated/],
    ['required scenario renamed', summary => {
      summary.scenarios[0].name = 'renamed mandatory scenario'
    }, /missing mandatory scenario/],
    ['required scenario did not pass', summary => { summary.scenarios[1].status = 'fail' }, /did not pass/],
    ['required scenario detail disappeared', summary => {
      delete summary.scenarios[2].detail
    }, /missing its detail/],
    ['required scenario detail is empty', summary => { summary.scenarios[3].detail = {} }, /detail/],
    ['required scenario detail is an array', summary => { summary.scenarios[4].detail = ['x'] }, /detail/],
    ['required scenario detail is a string', summary => {
      summary.scenarios[5].detail = 'covered'
    }, /detail/],
  ]
  for (const [name, mutate, pattern] of cases) {
    const summary = gateSummary()
    mutate(summary)
    const result = validateGateSummary(summary, summaryOptions)
    assert.equal(result.ok, false, name)
    assert.match(result.errors.join('\n'), pattern, name)
  }
})

test('the gate summary records the real report evidence and report digests', () => {
  const e2e = e2eReport()
  const docker = dockerReport()
  const proxy = proxyReport()
  const reports = {
    e2e: { bytes: Buffer.from(JSON.stringify(e2e)), report: e2e },
    docker: { bytes: Buffer.from(JSON.stringify(docker)), report: docker },
    proxy: { bytes: Buffer.from(JSON.stringify(proxy)), report: proxy },
  }
  const snapshot = buildGateEvidenceSnapshot(reports)
  assert.equal(snapshot.e2e.reportSha256, sha256(reports.e2e.bytes))
  assert.equal(snapshot.docker.reportSha256, sha256(reports.docker.bytes))
  assert.equal(snapshot.proxy.reportSha256, sha256(reports.proxy.bytes))
  assert.match(snapshot.e2e.reportSha256, /^[0-9a-f]{64}$/)
  assert.deepEqual(snapshot.e2e.flags,
    Object.fromEntries(GATE_E2E_FLAGS.map(flag => [flag, true])))
  assert.equal(snapshot.e2e.rendererProof.browserWindowCount, 2)
  assert.equal(snapshot.e2e.rendererProof.windowsHidden, true)
  assert.equal(snapshot.e2e.rendererProof.backgroundThrottlingDisabled, true)
  assert.equal(snapshot.e2e.stepCount, 36)
  assert.deepEqual(snapshot.docker.flags,
    Object.fromEntries(REQUIRED_DOCKER_EVIDENCE_FLAGS.map(flag => [flag, true])))
  assert.deepEqual(snapshot.proxy.flags,
    Object.fromEntries(REQUIRED_PROXY_EVIDENCE_FLAGS.map(flag => [flag, true])))

  // Values are copied from the report; a failing report is never rewritten to true.
  const failing = e2eReport()
  failing.result = 'FAIL'
  failing.evidence.realElectron = false
  failing.evidence.rendererProof.windowsHidden = false
  failing.evidence.rendererProof.backgroundThrottlingDisabled = false
  failing.evidence.stepCount = 1
  const failingSnapshot = buildGateEvidenceSnapshot({
    e2e: { bytes: Buffer.from('tampered report bytes'), report: failing },
    docker: null,
    proxy: null,
  })
  assert.equal(failingSnapshot.e2e.result, 'FAIL')
  assert.equal(failingSnapshot.e2e.flags.realElectron, false)
  assert.equal(failingSnapshot.e2e.rendererProof.windowsHidden, false)
  assert.equal(failingSnapshot.e2e.rendererProof.backgroundThrottlingDisabled, false)
  assert.equal(failingSnapshot.e2e.stepCount, 1)
  assert.equal(failingSnapshot.e2e.reportSha256, sha256(Buffer.from('tampered report bytes')))
  assert.equal(failingSnapshot.docker.reportSha256, null)
  assert.equal(failingSnapshot.proxy.reportSha256, null)

  const steps = REQUIRED_GATE_COMMANDS.map(required => ({
    id: required.id,
    label: required.id,
    command: 'npm',
    args: required.command.replace(/^npm\s+/, '').split(' '),
  }))
  const commandStartMs = NOW - 100_000
  const results = steps.map((step, index) => ({
    id: step.id,
    label: step.label,
    command: [step.command, ...step.args].join(' '),
    code: 0,
    durationMs: 500,
    startedAt: new Date(commandStartMs + index * 1_000).toISOString(),
    finishedAt: new Date(commandStartMs + index * 1_000 + 500).toISOString(),
  }))
  const summary = buildGateSummary({
    results,
    steps,
    revision: REV,
    revisionAfter: REV,
    startedAtMs: NOW - 120_000,
    finishedAtMs: NOW - 1_000,
    gateEvaluation: {
      ok: true,
      workingTreeBefore: { clean: true },
      workingTreeAfter: { clean: true },
    },
    e2eReport: e2e,
    reports,
  })
  assert.deepEqual(summary.evidence, snapshot)
  const validation = validateGateSummary(summary, {
    currentRevision: REV,
    nowMs: NOW,
    notBeforeMs: NOW - 180_000,
  })
  assert.equal(validation.ok, true, validation.errors.join('\n'))
})

test('git status parsing includes untracked paths and both sides of renames', () => {
  const entries = parseGitStatusPorcelain(
    '?? src/new-source.ts\0'
    + ' M docs/superpowers/acceptance/artifacts/c12-e2e/report.json\0'
    + 'R  src/new-name.ts\0src/old-name.ts\0',
  )
  assert.deepEqual(entries, [
    { status: '??', path: 'src/new-source.ts' },
    { status: ' M', path: 'docs/superpowers/acceptance/artifacts/c12-e2e/report.json' },
    { status: 'R ', path: 'src/new-name.ts', previousPath: 'src/old-name.ts' },
  ])
})

test('only explicit acceptance artifacts and generated temp paths are allowed gate dirt', () => {
  assert.deepEqual(evaluateWorkingTree([]), {
    captured: true,
    clean: true,
    changedPaths: [],
    disallowedPaths: [],
  })
  const generated = evaluateWorkingTree([
    { status: ' M', path: 'docs/superpowers/acceptance/artifacts/c12-docker/docker-smoke-report.json' },
    'docs/superpowers/acceptance/2026-10-23-c12-final-gate.md',
    'out/docker-smoke-123/credential',
  ])
  assert.equal(generated.clean, true)
  const disallowed = evaluateWorkingTree([
    'src/main.ts',
    'docs/superpowers/acceptance/operator-notes.md',
    'server/docker-compose.yml',
    'scripts/replacement.mjs',
  ])
  assert.equal(disallowed.clean, false)
  assert.deepEqual(disallowed.disallowedPaths, [
    'src/main.ts',
    'docs/superpowers/acceptance/operator-notes.md',
    'server/docker-compose.yml',
    'scripts/replacement.mjs',
  ])
})

test('the gate clears old evidence before writing fresh artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qqpet-gate-evidence-'))
  const evidence = join(root, 'c12-e2e')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(evidence, { recursive: true })
  await writeFile(join(evidence, 'stale-report.json'), '{"result":"PASS"}')
  await cleanEvidenceDirectory(evidence)
  assert.deepEqual(await readdir(evidence), [])
  await assert.rejects(access(join(evidence, 'stale-report.json')))
})

function gateInput(overrides = {}) {
  return {
    results: [{ code: 0 }, { code: 0 }, { code: 0 }],
    expectedStepCount: 3,
    revision: REV,
    revisionAfter: REV,
    e2eReport: e2eReport(),
    dockerReport: dockerReport(),
    proxyReport: proxyReport(),
    workingTreeBefore: [],
    workingTreeAfter: [],
    nowMs: NOW,
    notBeforeMs: NOW - 180_000,
    ...overrides,
  }
}

test('the pure acceptance decision fails closed for every command/evidence condition', () => {
  const cleanGate = evaluateAcceptanceGate(gateInput())
  assert.equal(cleanGate.ok, true)
  assert.equal(cleanGate.workingTreeClean, true)
  const generatedTree = gateInput({
    workingTreeBefore: [{ status: ' M', path: 'docs/superpowers/acceptance/2026-10-23-c12-final-gate.md' }],
    workingTreeAfter: [{ status: '??', path: 'docs/superpowers/acceptance/artifacts/c12-e2e/report.json' }],
  })
  const generatedResult = evaluateAcceptanceGate(generatedTree)
  assert.equal(generatedResult.ok, true)
  assert.equal(generatedResult.workingTreeClean, true)
  const dirtyResult = evaluateAcceptanceGate(gateInput({
    workingTreeAfter: [{ status: '??', path: 'src/untracked.ts' }],
  }))
  assert.equal(dirtyResult.ok, false)
  assert.equal(dirtyResult.workingTreeClean, false)
  assert.match(dirtyResult.errors.join('\n'), /after the acceptance gate contains non-generated changes: src\/untracked\.ts/)
  const cases = [
    ['failed command', gate => { gate.results[1].code = 1 }, /commands failed/],
    ['short command list', gate => { gate.results.pop() }, /commands failed/],
    ['changed HEAD', gate => { gate.revisionAfter = 'b'.repeat(40) }, /HEAD changed/],
    ['dirty source before gate', gate => {
      gate.workingTreeBefore = [{ status: ' M', path: 'src/main.ts' }]
    }, /before the acceptance gate contains non-generated changes: src\/main.ts/],
    ['dirty script after gate', gate => {
      gate.workingTreeAfter = [{ status: '??', path: 'scripts/replacement.mjs' }]
    }, /after the acceptance gate contains non-generated changes: scripts\/replacement.mjs/],
    ['unexpected acceptance note is not generated evidence', gate => {
      gate.workingTreeBefore = ['docs/superpowers/acceptance/operator-notes.md']
    }, /operator-notes\.md/],
    ['before status capture missing', gate => {
      delete gate.workingTreeBefore
    }, /status before the acceptance gate was not captured/],
    ['after status capture missing', gate => {
      delete gate.workingTreeAfter
    }, /status after the acceptance gate was not captured/],
    ['missing E2E report', gate => { gate.e2eReport = null }, /report is missing/],
    ['missing Docker report', gate => { gate.dockerReport = null }, /Docker: .*report is missing/],
    ['missing proxy report', gate => { gate.proxyReport = null }, /TLS\/WSS proxy smoke report is missing/],
    ['failed E2E report', gate => { gate.e2eReport.result = 'FAIL' }, /exactly "PASS"/],
    ['wrong revision E2E report', gate => { gate.e2eReport.codeRevision = 'b'.repeat(40) }, /current HEAD/],
    ['stale Docker report', gate => { gate.dockerReport.finishedAt = new Date(NOW - 31 * 60_000).toISOString() }, /stale/],
    ['Docker restore failure', gate => { gate.dockerReport.evidence.restoreContentMatched = false }, /restoreContentMatched/],
    ['proxy route failure', gate => { gate.proxyReport.evidence.syncAliasAuthenticated = false }, /syncAliasAuthenticated/],
    ['old evidence from before gate start', gate => {
      gate.proxyReport.startedAt = new Date(NOW - 600_000).toISOString()
      gate.proxyReport.finishedAt = new Date(NOW - 500_000).toISOString()
    }, /not produced by this gate run/],
  ]
  for (const [name, mutate, pattern] of cases) {
    const gate = gateInput()
    mutate(gate)
    const result = evaluateAcceptanceGate(gate)
    assert.equal(result.ok, false, name)
    assert.match(result.errors.join('\n'), pattern, name)
  }
})

test('the evidence validator CLI exits non-zero for a report that is present but not passing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qqpet-evidence-cli-'))
  await mkdir(join(root, 'scripts/lib'), { recursive: true })
  await mkdir(join(root, 'src'), { recursive: true })
  await copyFile(fileURLToPath(new URL('../validate-evidence.mjs', import.meta.url)),
    join(root, 'scripts/validate-evidence.mjs'))
  await copyFile(fileURLToPath(new URL('../lib/acceptance-evidence.mjs', import.meta.url)),
    join(root, 'scripts/lib/acceptance-evidence.mjs'))
  await writeFile(join(root, 'src/main.ts'), 'export const value = 1\n')
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git(['init', '--initial-branch=main'])
  git(['config', 'user.name', 'Evidence Test'])
  git(['config', 'user.email', 'evidence-test@example.invalid'])
  git(['add', '-A'])
  git(['commit', '-m', 'tested source tree'])
  const revision = git(['rev-parse', 'HEAD'])

  const reportDirectory = await mkdtemp(join(tmpdir(), 'qqpet-evidence-cli-report-'))
  const reportPath = join(reportDirectory, 'report.json')
  const now = Date.now()
  const report = {
    ...e2eReport(),
    startedAt: new Date(now - 2_000).toISOString(),
    finishedAt: new Date(now - 1_000).toISOString(),
    codeRevision: revision,
  }
  const { QQPET_CODE_REVISION, ...cleanEnv } = process.env
  await writeFile(reportPath, JSON.stringify(report))
  const valid = spawnSync(process.execPath, ['scripts/validate-evidence.mjs', 'e2e', reportPath], {
    cwd: root,
    env: cleanEnv,
    encoding: 'utf8',
  })
  assert.equal(valid.status, 0, valid.stderr)
  report.result = 'FAIL'
  await writeFile(reportPath, JSON.stringify(report))
  const invalid = spawnSync(process.execPath, ['scripts/validate-evidence.mjs', 'e2e', reportPath], {
    cwd: root,
    env: cleanEnv,
    encoding: 'utf8',
  })
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /exactly "PASS"/)
})

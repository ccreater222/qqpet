import assert from 'node:assert/strict'
import { access, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  cleanEvidenceDirectory,
  evaluateAcceptanceGate,
  validateDockerSmokeReport,
  validateE2EReport,
  validateProxySmokeReport,
} from '../lib/acceptance-evidence.mjs'

const NOW = Date.parse('2026-10-22T21:00:00.000Z')
const REV = 'a'.repeat(40)
const startedAt = new Date(NOW - 120_000).toISOString()
const finishedAt = new Date(NOW - 1_000).toISOString()

function e2eSteps(count = 15) {
  return Array.from({ length: count }, (_, index) => ({
    name: 'scenario-' + String(index + 1),
    status: 'pass',
    durationMs: index + 1,
  }))
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
      stepCount: 15,
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
    ['too few steps', () => ({ ...e2eReport(), steps: e2eSteps(14) }), /minimum is 15/],
    ['duplicate step names', () => {
      const report = e2eReport()
      report.steps = Array.from({ length: 15 }, () => ({ name: 'same', status: 'pass', durationMs: 1 }))
      return report
    }, /unique named steps/],
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
    ['stepCount mismatch', () => {
      const report = e2eReport()
      report.evidence.stepCount = 14
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

test('Docker smoke evidence requires boot, WAL/FULL, non-root and backup/restore content assertions', () => {
  assert.deepEqual(validateDockerSmokeReport(dockerReport(), options), { ok: true, errors: [] })
  const cases = [
    ['missing image build', report => { report.evidence.imageBuilt = false }, /imageBuilt/],
    ['wrong journal mode', report => { report.evidence.journalMode = 'delete' }, /journalMode/],
    ['not synchronous full', report => { report.evidence.synchronous = 'normal' }, /synchronous/],
    ['root uid', report => { report.evidence.uid = 0 }, /uid/],
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
  ]
  for (const [name, mutate, pattern] of cases) {
    const report = proxyReport()
    mutate(report)
    const result = validateProxySmokeReport(report, options)
    assert.equal(result.ok, false, name)
    assert.match(result.errors.join('\n'), pattern, name)
  }
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
    nowMs: NOW,
    notBeforeMs: NOW - 180_000,
    ...overrides,
  }
}

test('the pure acceptance decision fails closed for every command/evidence condition', () => {
  assert.equal(evaluateAcceptanceGate(gateInput()).ok, true)
  const cases = [
    ['failed command', gate => { gate.results[1].code = 1 }, /commands failed/],
    ['short command list', gate => { gate.results.pop() }, /commands failed/],
    ['changed HEAD', gate => { gate.revisionAfter = 'b'.repeat(40) }, /HEAD changed/],
    ['missing E2E report', gate => { gate.e2eReport = null }, /report is missing/],
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
  const reportPath = join(root, 'report.json')
  const now = Date.now()
  const report = {
    ...e2eReport(),
    startedAt: new Date(now - 2_000).toISOString(),
    finishedAt: new Date(now - 1_000).toISOString(),
    codeRevision: REV,
  }
  await writeFile(reportPath, JSON.stringify(report))
  const valid = spawnSync(process.execPath, ['scripts/validate-evidence.mjs', 'e2e', reportPath], {
    cwd: new URL('../..', import.meta.url),
    env: { ...process.env, QQPET_CODE_REVISION: REV },
    encoding: 'utf8',
  })
  assert.equal(valid.status, 0, valid.stderr)
  report.result = 'FAIL'
  await writeFile(reportPath, JSON.stringify(report))
  const invalid = spawnSync(process.execPath, ['scripts/validate-evidence.mjs', 'e2e', reportPath], {
    cwd: new URL('../..', import.meta.url),
    env: { ...process.env, QQPET_CODE_REVISION: REV },
    encoding: 'utf8',
  })
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /exactly "PASS"/)
})

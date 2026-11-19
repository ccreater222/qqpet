/**
 * The gate summary must be bound to the exact report bytes it claims to
 * summarize. These tests exercise the CLI in a temporary repository so a
 * rewritten gate-summary.json alone (or a report edited after the gate) cannot
 * pass `validate-evidence gate`.
 */
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  E2E_MIN_STEPS,
  REQUIRED_DOCKER_EVIDENCE_FLAGS,
  REQUIRED_E2E_EVIDENCE_FLAGS,
  REQUIRED_E2E_SCENARIO_NAMES,
  REQUIRED_GATE_COMMANDS,
  REQUIRED_PROXY_EVIDENCE_FLAGS,
} from '../lib/acceptance-evidence.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const VALIDATOR_SOURCE = resolve(HERE, '../validate-evidence.mjs')
const LIBRARY_SOURCE = resolve(HERE, '../lib/acceptance-evidence.mjs')
const ARTIFACT_ROOT = '.agent-reports/acceptance/artifacts'
const REPORT_PATHS = {
  e2e: ARTIFACT_ROOT + '/c12-e2e/c12-e2e-report.json',
  docker: ARTIFACT_ROOT + '/c12-docker/docker-smoke-report.json',
  proxy: ARTIFACT_ROOT + '/c12-proxy/proxy-smoke-report.json',
  gate: ARTIFACT_ROOT + '/c12-gate/gate-summary.json',
}
const GATE_E2E_FLAGS = [
  'twoProcesses',
  'realStandaloneServer',
  'realWebSocket',
  'realElectron',
  'realRenderer',
  'rendererCoverage',
  'guiCoverage',
]
const RENDERER_PROOF_FLAGS = [
  'windowsHidden',
  'hiddenRendererActive',
  'preloadApiExposed',
  'contextIsolation',
  'sandboxedPreload',
  'nodeIntegrationDisabled',
]

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, 'git ' + args.join(' ') + ' failed:\n' + result.stderr)
  return result.stdout.trim()
}

function commitAll(root, message) {
  runGit(root, ['add', '-A'])
  runGit(root, ['commit', '-m', message])
}

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), 'qqpet-gate-binding-'))
  await mkdir(join(root, 'scripts/lib'), { recursive: true })
  await mkdir(join(root, 'src'), { recursive: true })
  await copyFile(VALIDATOR_SOURCE, join(root, 'scripts/validate-evidence.mjs'))
  await copyFile(LIBRARY_SOURCE, join(root, 'scripts/lib/acceptance-evidence.mjs'))
  await writeFile(join(root, 'src/main.ts'), 'export const value = 1\n')
  runGit(root, ['init', '--initial-branch=main'])
  runGit(root, ['config', 'user.name', 'Evidence Test'])
  runGit(root, ['config', 'user.email', 'evidence-test@example.invalid'])
  commitAll(root, 'tested source tree')
  return { root, testedRevision: runGit(root, ['rev-parse', 'HEAD']) }
}

function e2eReport(revision, now) {
  const requiredSteps = REQUIRED_E2E_SCENARIO_NAMES.map((name, index) => ({
    name,
    status: 'pass',
    durationMs: index + 1,
    detail: { requiredIndex: index },
  }))
  const filler = Array.from({ length: E2E_MIN_STEPS - requiredSteps.length }, (_, index) => ({
    name: 'setup-step-' + String(index + 1),
    status: 'pass',
    durationMs: 100 + index,
    detail: { setup: true },
  }))
  const steps = [...requiredSteps, ...filler]
  return {
    result: 'PASS',
    codeRevision: revision,
    startedAt: new Date(now - 5_000).toISOString(),
    finishedAt: new Date(now - 4_000).toISOString(),
    steps,
    evidence: {
      // A full C12 report: the gate CLI now runs the same deep validators as the
      // gate itself, so a digest-bound report must satisfy every required flag.
      ...Object.fromEntries(REQUIRED_E2E_EVIDENCE_FLAGS.map(flag => [flag, true])),
      stepCount: steps.length,
      commandRetries: { total: 0, entries: [] },
      rendererProof: {
        electronMainPidsDistinct: true,
        browserWindowCount: 2,
        rendererProcessCount: 2,
        ...Object.fromEntries(RENDERER_PROOF_FLAGS.map(flag => [flag, true])),
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

function dockerReport(revision, now) {
  return {
    result: 'PASS',
    codeRevision: revision,
    startedAt: new Date(now - 5_000).toISOString(),
    finishedAt: new Date(now - 4_000).toISOString(),
    evidence: {
      ...Object.fromEntries(REQUIRED_DOCKER_EVIDENCE_FLAGS.map(flag => [flag, true])),
      journalMode: 'wal',
      synchronous: 'full',
      uid: 1000,
      credentialRuntimeUid: 1000,
      credentialRuntimeMode: 0o400,
    },
  }
}

function proxyReport(revision, now) {
  return {
    result: 'PASS',
    codeRevision: revision,
    startedAt: new Date(now - 5_000).toISOString(),
    finishedAt: new Date(now - 4_000).toISOString(),
    evidence: Object.fromEntries(REQUIRED_PROXY_EVIDENCE_FLAGS.map(flag => [flag, true])),
  }
}

function gateSummary({ revision, now, digests, reports }) {
  const commandStartMs = now - 100_000
  return {
    schemaVersion: 1,
    result: 'PASS',
    codeRevision: revision,
    startedAt: new Date(now - 120_000).toISOString(),
    finishedAt: new Date(now - 1_000).toISOString(),
    cleanTree: { before: true, after: true },
    head: { before: revision, after: revision },
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
    evidence: {
      e2e: {
        reportSha256: digests.e2e,
        result: reports.e2e.result,
        codeRevision: reports.e2e.codeRevision,
        stepCount: reports.e2e.evidence.stepCount,
        commandRetries: reports.e2e.evidence.commandRetries.total,
        flags: Object.fromEntries(
          GATE_E2E_FLAGS.map(flag => [flag, reports.e2e.evidence[flag] === true]),
        ),
        rendererProof: {
          browserWindowCount: reports.e2e.evidence.rendererProof.browserWindowCount,
          rendererProcessCount: reports.e2e.evidence.rendererProof.rendererProcessCount,
          ...Object.fromEntries(RENDERER_PROOF_FLAGS.map(flag => [
            flag,
            reports.e2e.evidence.rendererProof[flag] === true,
          ])),
        },
      },
      docker: {
        reportSha256: digests.docker,
        result: reports.docker.result,
        codeRevision: reports.docker.codeRevision,
        flags: Object.fromEntries(REQUIRED_DOCKER_EVIDENCE_FLAGS.map(flag => [
          flag,
          reports.docker.evidence[flag] === true,
        ])),
      },
      proxy: {
        reportSha256: digests.proxy,
        result: reports.proxy.result,
        codeRevision: reports.proxy.codeRevision,
        flags: Object.fromEntries(REQUIRED_PROXY_EVIDENCE_FLAGS.map(flag => [
          flag,
          reports.proxy.evidence[flag] === true,
        ])),
      },
    },
  }
}

async function writeReport(root, relativePath, report) {
  const path = join(root, relativePath)
  await mkdir(dirname(path), { recursive: true })
  const bytes = JSON.stringify(report, null, 2) + '\n'
  await writeFile(path, bytes)
  return { path, relativePath, bytes, digest: sha256(bytes) }
}

async function setupGate() {
  const { root, testedRevision } = await createRepository()
  const now = Date.now()
  const reports = {
    e2e: e2eReport(testedRevision, now),
    docker: dockerReport(testedRevision, now),
    proxy: proxyReport(testedRevision, now),
  }
  const files = {}
  for (const kind of ['e2e', 'docker', 'proxy']) {
    files[kind] = await writeReport(root, REPORT_PATHS[kind], reports[kind])
  }
  const summary = gateSummary({
    revision: testedRevision,
    now,
    digests: {
      e2e: files.e2e.digest,
      docker: files.docker.digest,
      proxy: files.proxy.digest,
    },
    reports,
  })
  const summaryFile = await writeReport(root, REPORT_PATHS.gate, summary)
  commitAll(root, 'record acceptance evidence')
  return { root, testedRevision, now, reports, files, summary, summaryFile }
}

function validateGate(root) {
  const { QQPET_CODE_REVISION, QQPET_EVIDENCE_NOT_BEFORE_MS, ...env } = process.env
  return spawnSync(process.execPath, ['scripts/validate-evidence.mjs', 'gate'], {
    cwd: root,
    env,
    encoding: 'utf8',
  })
}

test('gate CLI accepts a summary whose evidence digests match the report bytes', async () => {
  const { root } = await setupGate()
  const valid = validateGate(root)
  assert.equal(valid.status, 0, valid.stderr)
  assert.match(valid.stdout, /\[evidence\] PASS gate:/)
  assert.match(valid.stdout, /gate evidence digests: e2e=[0-9a-f]{64} docker=[0-9a-f]{64} proxy=[0-9a-f]{64}/)
})

test('gate CLI rejects a sub-report edited after the summary was written', async () => {
  const { root, reports } = await setupGate()
  const tampered = { ...reports.e2e, evidenceStepCountNote: 'rewritten after the gate' }
  await writeReport(root, REPORT_PATHS.e2e, tampered)
  commitAll(root, 'tamper with the recorded E2E report')
  const result = validateGate(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /sha256 digest/)
  assert.match(result.stderr, /does not match gate-summary evidence\.e2e\.reportSha256/)
  assert.match(result.stderr, new RegExp(escapeRegExp(REPORT_PATHS.e2e)))
  assert.doesNotMatch(result.stdout, /\[evidence\] PASS gate:/)
})

test('gate CLI fails closed when a bound sub-report is missing', async () => {
  const { root } = await setupGate()
  await rm(join(root, REPORT_PATHS.e2e))
  commitAll(root, 'delete the recorded E2E report')
  const result = validateGate(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /E2E report file is missing/)
  assert.match(result.stderr, new RegExp(escapeRegExp(REPORT_PATHS.e2e)))
  assert.doesNotMatch(result.stdout, /\[evidence\] PASS gate:/)
})

test('gate CLI rejects a digest-matched report that is not passing', async () => {
  const { root, summary, reports } = await setupGate()
  const failing = { ...reports.e2e, result: 'FAIL' }
  const file = await writeReport(root, REPORT_PATHS.e2e, failing)
  const rebound = {
    ...summary,
    evidence: {
      ...summary.evidence,
      e2e: { ...summary.evidence.e2e, reportSha256: file.digest },
    },
  }
  await writeReport(root, REPORT_PATHS.gate, rebound)
  commitAll(root, 'rebind a failing report digest')
  const result = validateGate(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /E2E report at .*result must be exactly "PASS"/)
  assert.doesNotMatch(result.stderr, /sha256 digest/)
  assert.doesNotMatch(result.stdout, /\[evidence\] PASS gate:/)
})

test('gate CLI rejects a digest-matched report from another revision', async () => {
  const { root, summary, reports } = await setupGate()
  const foreign = { ...reports.docker, codeRevision: 'b'.repeat(40) }
  const file = await writeReport(root, REPORT_PATHS.docker, foreign)
  const rebound = {
    ...summary,
    evidence: {
      ...summary.evidence,
      docker: { ...summary.evidence.docker, reportSha256: file.digest },
    },
  }
  await writeReport(root, REPORT_PATHS.gate, rebound)
  commitAll(root, 'rebind a foreign-revision report digest')
  const result = validateGate(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Docker smoke report codeRevision .*does not match gate summary codeRevision/)
  assert.doesNotMatch(result.stderr, /sha256 digest/)
  assert.doesNotMatch(result.stdout, /\[evidence\] PASS gate:/)
})

test('gate CLI rejects a summary that does not prove a live hidden renderer', async () => {
  const { root, summary, reports } = await setupGate()
  const unthrottled = {
    ...reports.e2e,
    evidence: {
      ...reports.e2e.evidence,
      rendererProof: {
        ...reports.e2e.evidence.rendererProof,
        hiddenRendererActive: false,
      },
    },
  }
  const file = await writeReport(root, REPORT_PATHS.e2e, unthrottled)
  const rebound = {
    ...summary,
    evidence: {
      ...summary.evidence,
      e2e: {
        ...summary.evidence.e2e,
        reportSha256: file.digest,
        rendererProof: {
          ...summary.evidence.e2e.rendererProof,
          hiddenRendererActive: false,
        },
      },
    },
  }
  await writeReport(root, REPORT_PATHS.gate, rebound)
  commitAll(root, 'record unthrottled hidden-window evidence')
  const result = validateGate(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /rendererProof\.hiddenRendererActive must be true/)
  assert.doesNotMatch(result.stderr, /sha256 digest/)
  assert.doesNotMatch(result.stdout, /\[evidence\] PASS gate:/)
})

test('gate CLI rejects a digest-matched Docker report that the docker validator rejects', async () => {
  const { root, summary, reports } = await setupGate()
  const broken = {
    ...reports.docker,
    evidence: { ...reports.docker.evidence, journalMode: 'delete' },
  }
  const file = await writeReport(root, REPORT_PATHS.docker, broken)
  const rebound = {
    ...summary,
    evidence: {
      ...summary.evidence,
      docker: { ...summary.evidence.docker, reportSha256: file.digest },
    },
  }
  await writeReport(root, REPORT_PATHS.gate, rebound)
  commitAll(root, 'rebind a docker report without wal journal mode')
  const result = validateGate(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Docker smoke report validation: .*journalMode/)
  assert.doesNotMatch(result.stdout, /\[evidence\] PASS gate:/)
})

test('gate CLI rejects a digest-matched E2E report below the deep step minimum', async () => {
  const { root, summary, reports } = await setupGate()
  const shortSteps = reports.e2e.steps.slice(0, REQUIRED_E2E_SCENARIO_NAMES.length)
  const short = {
    ...reports.e2e,
    steps: shortSteps,
    evidence: { ...reports.e2e.evidence, stepCount: shortSteps.length },
  }
  const file = await writeReport(root, REPORT_PATHS.e2e, short)
  const rebound = {
    ...summary,
    evidence: {
      ...summary.evidence,
      e2e: { ...summary.evidence.e2e, reportSha256: file.digest },
    },
  }
  await writeReport(root, REPORT_PATHS.gate, rebound)
  commitAll(root, 'rebind an 18-step E2E report')
  const result = validateGate(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /E2E report validation: .*minimum is 36/)
  assert.doesNotMatch(result.stdout, /\[evidence\] PASS gate:/)
})

test('gate CLI rejects summary scenarios that do not match the digest-bound E2E report', async () => {
  const { root, summary } = await setupGate()
  const forged = {
    ...summary,
    scenarios: summary.scenarios.map((scenario, index) => index === 0
      ? { ...scenario, detail: { ...scenario.detail, forged: true } }
      : scenario),
  }
  await writeReport(root, REPORT_PATHS.gate, forged)
  commitAll(root, 'forge a selected scenario detail')
  const result = validateGate(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /does not match the digest-bound E2E report step/)
  assert.doesNotMatch(result.stderr, /sha256 digest/)
  assert.doesNotMatch(result.stdout, /\[evidence\] PASS gate:/)
})

test('gate CLI rejects a retry-storm summary', async () => {
  const { root, summary } = await setupGate()
  const storm = {
    ...summary,
    evidence: {
      ...summary.evidence,
      e2e: { ...summary.evidence.e2e, commandRetries: 6 },
    },
  }
  await writeReport(root, REPORT_PATHS.gate, storm)
  commitAll(root, 'forge a retry storm count')
  const result = validateGate(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /commandRetries.*retry storm/)
  assert.doesNotMatch(result.stdout, /\[evidence\] PASS gate:/)
})

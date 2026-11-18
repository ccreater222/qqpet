/**
 * C12 final acceptance gate.
 *
 * Runs the release-blocking commands in one place and writes concise evidence
 * to docs/superpowers/acceptance/. A zero command exit status is not enough:
 * fresh E2E, Docker backup/restore and TLS/WSS proxy reports are parsed and must
 * independently prove their required evidence at the exact current revision.
 * The tree must also remain free of non-generated changes before and after the
 * commands; only acceptance artifacts and explicit smoke temp paths are exempt.
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GATE_SUMMARY_SCHEMA_VERSION,
  REQUIRED_E2E_SCENARIO_NAMES,
  REQUIRED_GATE_COMMAND_IDS,
  cleanEvidenceDirectory,
  evaluateAcceptanceGate,
  parseGitStatusPorcelain,
  validateGateSummary,
} from './lib/acceptance-evidence.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const STAMP = new Date().toISOString()
const DATE = STAMP.slice(0, 10)
const ACCEPTANCE_DIR = join(ROOT, 'docs/superpowers/acceptance')
const REPORT_PATH = join(ACCEPTANCE_DIR, DATE + '-c12-final-gate.md')
const E2E_ARTIFACT_DIR = join(ACCEPTANCE_DIR, 'artifacts/c12-e2e')
const E2E_REPORT_PATH = join(E2E_ARTIFACT_DIR, 'c12-e2e-report.json')
const DOCKER_ARTIFACT_DIR = join(ACCEPTANCE_DIR, 'artifacts/c12-docker')
const DOCKER_REPORT_PATH = join(DOCKER_ARTIFACT_DIR, 'docker-smoke-report.json')
const PROXY_ARTIFACT_DIR = join(ACCEPTANCE_DIR, 'artifacts/c12-proxy')
const PROXY_REPORT_PATH = join(PROXY_ARTIFACT_DIR, 'proxy-smoke-report.json')
const GATE_ARTIFACT_DIR = join(ACCEPTANCE_DIR, 'artifacts/c12-gate')
const GATE_SUMMARY_PATH = join(GATE_ARTIFACT_DIR, 'gate-summary.json')
const FAILURE_TAIL_CHARS = 4000

function runGit(args, options = {}) {
  return new Promise(resolveRun => {
    const child = spawn('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('close', code => resolveRun({
      code,
      stdout: options.trim === false ? stdout : stdout.trim(),
      stderr: stderr.trim(),
    }))
  })
}

function gitStatusEntries(result) {
  if (result.code !== 0) return null
  try {
    return parseGitStatusPorcelain(result.stdout)
  } catch {
    return null
  }
}

function runCommand(id, label, command, args, options = {}) {
  return new Promise(resolveRun => {
    const startedAtMs = Date.now()
    const startedAt = new Date(startedAtMs).toISOString()
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      const finishedAtMs = Date.now()
      resolveRun({
        id,
        label,
        command: [command, ...args].join(' '),
        ...result,
        durationMs: finishedAtMs - startedAtMs,
        startedAt,
        finishedAt: new Date(finishedAtMs).toISOString(),
      })
    }
    process.stdout.write('\n[gate] >>> ' + label + '\n')
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      const text = String(chunk)
      stdout += text
      process.stdout.write(text)
    })
    child.stderr.on('data', chunk => {
      const text = String(chunk)
      stderr += text
      process.stderr.write(text)
    })
    child.once('error', error => {
      finish({
        code: -1,
        stdout,
        stderr,
        error: error.message,
      })
      process.stdout.write('[gate] <<< ' + label + ' spawn error\n')
    })
    child.once('close', code => {
      finish({ code, stdout, stderr })
      process.stdout.write('[gate] <<< ' + label + ' exit=' + code + '\n')
    })
  })
}

function tail(text) {
  if (text.length <= FAILURE_TAIL_CHARS) return text
  return text.slice(text.length - FAILURE_TAIL_CHARS)
}

function testSummary(text) {
  const passLine = text.split('\n').filter(line => line.startsWith('# pass ')).at(-1)
  const failLine = text.split('\n').filter(line => line.startsWith('# fail ')).at(-1)
  if (passLine === undefined && failLine === undefined) return null
  return [passLine, failLine].filter(Boolean).join(', ')
}

function fence(text) {
  return '```text\n' + text.replaceAll('```', '` ``') + '\n```'
}

function markdownRow(values) {
  return '| ' + values.join(' | ') + ' |'
}

async function readJsonReport(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

function validationLine(label, validation) {
  return '- ' + label + ': **' + (validation.ok ? 'PASS' : 'FAIL') + '**'
}

/**
 * Build the authoritative machine summary from the exact objects that the
 * human-readable markdown is rendered from. The summary intentionally carries
 * all mandatory scenario details so a rename cannot silently drop one.
 */
function buildGateSummary(options) {
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
    result: options.gateEvaluation.ok ? 'PASS' : 'FAIL',
    codeRevision: options.revision,
    startedAt: new Date(options.startedAtMs).toISOString(),
    finishedAt: new Date(options.finishedAtMs).toISOString(),
    cleanTree: {
      before: options.gateEvaluation.workingTreeBefore.clean === true,
      after: options.gateEvaluation.workingTreeAfter.clean === true,
    },
    head: {
      before: options.revision,
      after: options.revisionAfter,
    },
    commands,
    scenarios,
  }
}

async function main() {
  const revision = await runGit(['rev-parse', 'HEAD'])
  const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'])
  // Capture cleanliness before creating directories or clearing tracked
  // historical evidence files.
  // Untracked files are included so an evidence-only bypass cannot hide a
  // source, config, test or replacement-report change.
  const dirtyBefore = await runGit(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { trim: false },
  )
  await mkdir(ACCEPTANCE_DIR, { recursive: true })
  // Always start from empty evidence directories. A failed or skipped smoke
  // command must never leave an older PASS report available for the gate.
  await Promise.all([
    cleanEvidenceDirectory(E2E_ARTIFACT_DIR),
    cleanEvidenceDirectory(DOCKER_ARTIFACT_DIR),
    cleanEvidenceDirectory(PROXY_ARTIFACT_DIR),
    cleanEvidenceDirectory(GATE_ARTIFACT_DIR),
  ])
  const gateStartedAtMs = Date.now()
  const evidenceEnv = { QQPET_CODE_REVISION: revision.stdout }
  const results = []
  const steps = [
    { id: 'root-typecheck', label: 'root typecheck', command: 'npm', args: ['run', 'typecheck'] },
    { id: 'root-compatibility-tests', label: 'root compatibility tests', command: 'npm', args: ['run', 'test:compat'] },
    { id: 'desktop-build', label: 'desktop build', command: 'npm', args: ['run', 'build'] },
    { id: 'android-web-build', label: 'Android web build', command: 'npm', args: ['run', 'build:android-web'] },
    { id: 'harmony-web-build', label: 'Harmony web build', command: 'npm', args: ['run', 'build:harmony-web'] },
    { id: 'ios-web-build', label: 'iOS web build', command: 'npm', args: ['run', 'build:ios-web'] },
    { id: 'server-typecheck', label: 'server typecheck', command: NPM, args: ['--prefix', 'server', 'run', 'typecheck'] },
    { id: 'server-tests', label: 'server tests', command: NPM, args: ['--prefix', 'server', 'test'] },
    {
      id: 'real-server-two-electron-e2e',
      label: 'real-server two-Electron E2E',
      command: NPM,
      args: ['run', 'test:e2e'],
      env: { ...evidenceEnv, QQPET_E2E_ARTIFACTS: E2E_ARTIFACT_DIR },
    },
    {
      id: 'docker-compose-credential-smoke',
      label: 'Docker Compose required-credential config smoke',
      command: NPM,
      args: ['run', 'smoke:compose'],
    },
    {
      id: 'docker-image-backup-restore-smoke',
      label: 'Docker image/boot/health/backup/restore smoke',
      command: NPM,
      args: ['run', 'smoke:docker'],
      env: { ...evidenceEnv, QQPET_DOCKER_SMOKE_REPORT: DOCKER_REPORT_PATH },
    },
    {
      id: 'tls-wss-proxy-smoke',
      label: 'TLS/WSS Nginx proxy smoke',
      command: NPM,
      args: ['run', 'smoke:proxy'],
      env: { ...evidenceEnv, QQPET_PROXY_REPORT: PROXY_REPORT_PATH },
    },
  ]
  const actualStepIds = steps.map(step => step.id)
  if (actualStepIds.length !== REQUIRED_GATE_COMMAND_IDS.length
    || actualStepIds.some((id, index) => id !== REQUIRED_GATE_COMMAND_IDS[index])) {
    throw new Error('acceptance gate steps do not match the required command ids')
  }

  for (const step of steps) {
    const result = await runCommand(step.id, step.label, step.command, step.args, { env: step.env })
    results.push(result)
    if (result.code !== 0) break
  }

  const revisionAfter = await runGit(['rev-parse', 'HEAD'])
  const revisionStable = revisionAfter.code === 0 && revisionAfter.stdout === revision.stdout
  const [e2eReport, dockerReport, proxyReport] = await Promise.all([
    readJsonReport(E2E_REPORT_PATH),
    readJsonReport(DOCKER_REPORT_PATH),
    readJsonReport(PROXY_REPORT_PATH),
  ])
  // Keep the concise machine-readable evidence, not multi-process debug logs.
  await rm(join(E2E_ARTIFACT_DIR, 'c12-server.log'), { force: true })
  await rm(join(E2E_ARTIFACT_DIR, 'c12-owner-harness.log'), { force: true })
  // Capture the post-command tree before writing this gate's own report. The
  // report/artifact paths are the only explicitly allowed generated output.
  const dirtyAfter = await runGit(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { trim: false },
  )

  const gateEvaluation = evaluateAcceptanceGate({
    results,
    expectedStepCount: steps.length,
    revision: revision.stdout,
    revisionAfter: revisionAfter.stdout,
    workingTreeBefore: gitStatusEntries(dirtyBefore),
    workingTreeAfter: gitStatusEntries(dirtyAfter),
    e2eReport,
    dockerReport,
    proxyReport,
    nowMs: Date.now(),
    notBeforeMs: gateStartedAtMs,
  })
  const e2eValidation = gateEvaluation.e2e
  const dockerValidation = gateEvaluation.docker
  const proxyValidation = gateEvaluation.proxy
  const gateFinishedAtMs = Date.now()
  let gateSummary = buildGateSummary({
    results,
    steps,
    revision: revision.stdout,
    revisionAfter: revisionAfter.code === 0 ? revisionAfter.stdout : '',
    startedAtMs: gateStartedAtMs,
    finishedAtMs: gateFinishedAtMs,
    gateEvaluation,
    e2eReport,
  })
  const gateSummaryValidation = validateGateSummary(gateSummary, {
    currentRevision: revision.stdout,
    nowMs: Date.now(),
    notBeforeMs: gateStartedAtMs,
  })
  let allPassed = gateEvaluation.ok && gateSummaryValidation.ok
  if (allPassed === false && gateSummary.result === 'PASS') {
    gateSummary = { ...gateSummary, result: 'FAIL' }
  }
  const validationErrors = [
    ...gateEvaluation.errors,
    ...gateSummaryValidation.errors.map(error => 'Gate summary: ' + error),
  ]
  if (validationErrors.length > 0) gateSummary = { ...gateSummary, errors: validationErrors }
  await mkdir(GATE_ARTIFACT_DIR, { recursive: true })
  await writeFile(GATE_SUMMARY_PATH, JSON.stringify(gateSummary, null, 2) + '\n')
  const finalStatus = allPassed ? 'PASS' : 'FAIL'
  const lines = []
  lines.push('# C12 final acceptance gate')
  lines.push('')
  lines.push('- Result: **' + finalStatus + '**')
  lines.push('- Machine-readable authoritative summary: `docs/superpowers/acceptance/artifacts/c12-gate/gate-summary.json`')
  lines.push('- Generated at: `' + gateSummary.startedAt + '`')
  lines.push('- Branch: `' + branch.stdout + '`')
  lines.push('- Code revision under test: `' + revision.stdout + '`')
  lines.push('- Working tree before gate: **'
    + (gateEvaluation.workingTreeBefore.clean ? 'CLEAN' : 'FAIL') + '**'
    + (gateEvaluation.workingTreeBefore.disallowedPaths.length === 0
      ? ''
      : ' (non-generated: `' + gateEvaluation.workingTreeBefore.disallowedPaths.join('`, `') + '`)'))
  lines.push('- Working tree after commands: **'
    + (gateEvaluation.workingTreeAfter.clean ? 'CLEAN' : 'FAIL') + '**'
    + (gateEvaluation.workingTreeAfter.disallowedPaths.length === 0
      ? ''
      : ' (non-generated: `' + gateEvaluation.workingTreeAfter.disallowedPaths.join('`, `') + '`)'))
  lines.push('- Runtime: Node `' + process.version + '`, `' + process.platform + '/' + process.arch + '`')
  lines.push('- Renderer/GUI coverage: **required and asserted**. The E2E launches two real'
    + ' Electron applications and drives window.qqpet from real BrowserWindow/preload'
    + ' renderers; Linux CI runs it under xvfb.')
  lines.push('')
  lines.push('## Commands and results')
  lines.push('')
  lines.push(markdownRow(['#', 'Command id', 'Command', 'Result', 'Duration']))
  lines.push(markdownRow(['---', '---', '---', '---', '---:']))
  for (let index = 0; index < gateSummary.commands.length; index += 1) {
    const command = gateSummary.commands[index]
    const result = command.exitCode === 0
      ? 'PASS'
      : command.exitCode === null
        ? 'NOT RUN'
        : 'FAIL (' + command.exitCode + ')'
    lines.push(markdownRow([
      String(index + 1),
      '`' + command.id + '`',
      '`' + command.command + '`',
      result,
      command.exitCode === null ? '—' : String((command.durationMs / 1000).toFixed(1)) + 's',
    ]))
  }
  if (results.length < steps.length) {
    lines.push('')
    lines.push('Gate stopped after the first failure; remaining commands were not executed.')
  }
  const summaries = results
    .map(result => ({ label: result.label, summary: testSummary(result.stdout + result.stderr) }))
    .filter(item => item.summary !== null)
  if (summaries.length > 0) {
    lines.push('')
    lines.push('Observed node:test summaries:')
    lines.push('')
    for (const item of summaries) lines.push('- ' + item.label + ': `' + item.summary + '`')
  }
  lines.push('')
  lines.push('Equivalent server command sequence: `cd server && npm run typecheck && npm test`.')
  lines.push('Equivalent mobile web sequence: `npm run build:android-web`,'
    + ' `npm run build:harmony-web`, and `npm run build:ios-web`.')
  lines.push('')
  lines.push('## Evidence validation')
  lines.push('')
  lines.push(validationLine('Fresh E2E report', e2eValidation))
  lines.push(validationLine('Docker smoke report', dockerValidation))
  lines.push(validationLine('TLS/WSS proxy smoke report', proxyValidation))
  lines.push('- Machine-readable gate summary: **' + (allPassed ? 'PASS' : 'FAIL')
    + '** (authoritative; `gate-summary.json`)')
  lines.push('- Markdown gate report: explanatory only; validation reads the JSON summary')
  lines.push('- HEAD unchanged during gate: **' + (revisionStable ? 'PASS' : 'FAIL') + '**')
  lines.push('- Non-generated working tree before/after commands: **'
    + (gateEvaluation.workingTreeClean ? 'PASS' : 'FAIL') + '**')
  lines.push('- Current HEAD after commands: `' + revisionAfter.stdout + '`')
  if (validationErrors.length > 0) {
    lines.push('')
    lines.push('Validation errors:')
    lines.push('')
    for (const error of validationErrors) lines.push('- ' + error)
  }
  lines.push('')
  if (e2eReport !== null) {
    lines.push('## Real-server Electron E2E evidence')
    lines.push('')
    lines.push('- Evidence JSON: `docs/superpowers/acceptance/artifacts/c12-e2e/c12-e2e-report.json`')
    lines.push('- Result: **' + String(e2eReport.result).toUpperCase() + '**')
    lines.push('- Tested code revision: `' + String(e2eReport.codeRevision ?? 'missing') + '`')
    lines.push('- Named scenarios: `' + String(Array.isArray(e2eReport.steps) ? e2eReport.steps.length : 0) + '`')
    lines.push('- Two Electron processes: `' + String(e2eReport.evidence?.twoProcesses === true) + '`')
    lines.push('- Real standalone server: `' + String(e2eReport.evidence?.realStandaloneServer === true) + '`')
    lines.push('- Real WebSocket: `' + String(e2eReport.evidence?.realWebSocket === true) + '`')
    lines.push('- Real Electron applications: `' + String(e2eReport.evidence?.realElectron === true) + '`')
    lines.push('- Real renderer/preload execution: `' + String(e2eReport.evidence?.realRenderer === true) + '`')
    lines.push('- Renderer coverage: `' + String(e2eReport.evidence?.rendererCoverage === true) + '`')
    lines.push('- GUI coverage: `' + String(e2eReport.evidence?.guiCoverage === true) + '`')
    lines.push('- Browser windows / renderer processes: `'
      + String(e2eReport.evidence?.rendererProof?.browserWindowCount ?? 'missing') + '` / `'
      + String(e2eReport.evidence?.rendererProof?.rendererProcessCount ?? 'missing') + '`')
    lines.push('- Evidence step count: `' + String(e2eReport.evidence?.stepCount ?? 'missing') + '`')
    lines.push('- Competing actions covered: `' + String(e2eReport.evidence?.competingActionsCovered === true) + '`')
    lines.push('- Session token abuse covered: `' + String(e2eReport.evidence?.sessionTokenAbuseCovered === true) + '`')
    lines.push('- Fresh-host portable import covered: `' + String(e2eReport.evidence?.freshHostPortableImportCovered === true) + '`')
    lines.push('- Connected coverage reopen covered: `' + String(e2eReport.evidence?.connectedCoverageReopenCovered === true) + '`')
    lines.push('- Startup crash repair covered: `' + String(e2eReport.evidence?.startupCrashRepairCovered === true) + '`')
    lines.push('- Deterministic restart catch-up covered: `' + String(e2eReport.evidence?.deterministicRestartCovered === true) + '`')
    lines.push('- Revoked reconnect rejection covered: `' + String(e2eReport.evidence?.revokedReconnectCovered === true) + '`')
    lines.push('- Feed latency p95 covered: `' + String(e2eReport.evidence?.feedLatencyP95Covered === true) + '`')
    lines.push('- Timed server-owned deadline covered: `' + String(e2eReport.evidence?.timedServerDeadlineCovered === true) + '`')
    lines.push('- advanceWhileEmpty zero-client covered: `' + String(e2eReport.evidence?.advanceWhileEmptyZeroClientCovered === true) + '`')
    lines.push('- Online-time/sign-in split covered: `' + String(e2eReport.evidence?.onlineTimeSigninSplitCovered === true) + '`')
    lines.push('- Real LocalRepository handoff covered: `' + String(e2eReport.evidence?.localAuthorityHandoffCovered === true) + '`')
    lines.push('- Answer keys absent: `' + String(e2eReport.evidence?.answerKeysAbsent === true) + '`')
    lines.push('')
    lines.push(markdownRow(['Scenario', 'Status', 'Duration']))
    lines.push(markdownRow(['---', '---', '---:']))
    for (const scenario of e2eReport.steps ?? []) {
      lines.push(markdownRow([
        String(scenario.name),
        String(scenario.status).toUpperCase(),
        String(((scenario.durationMs ?? 0) / 1000).toFixed(2)) + 's',
      ]))
    }
    if (Array.isArray(e2eReport.residualGap)) {
      lines.push('')
      lines.push('### Honest residual gaps')
      lines.push('')
      for (const gap of e2eReport.residualGap) lines.push('- ' + String(gap))
    }
  } else {
    lines.push('## Real-server Electron E2E evidence')
    lines.push('')
    lines.push('No E2E JSON report was produced. Treat the gate as failed unless the command'
      + ' failure above is explained and the E2E is rerun successfully.')
  }
  lines.push('')
  lines.push('## Mandatory scenario coverage (authoritative gate summary)')
  lines.push('')
  const coveredScenarioCount = gateSummary.scenarios.filter(scenario =>
    String(scenario.status).toLowerCase() === 'pass'
    && scenario.detail !== null
    && scenario.detail !== undefined).length
  lines.push('- Required scenarios covered in JSON: **' + coveredScenarioCount
    + '/' + REQUIRED_E2E_SCENARIO_NAMES.length + '**')
  lines.push('- Details below are rendered from `gate-summary.json`; no separate selected-name'
    + ' list can silently skip a renamed scenario.')
  lines.push('')
  for (const scenario of gateSummary.scenarios) {
    const result = String(scenario.status).toUpperCase()
    const detail = scenario.detail === null || scenario.detail === undefined
      ? '**MISSING DETAIL**'
      : '`' + JSON.stringify(scenario.detail) + '`'
    lines.push('- `' + scenario.name + '` [' + result + ', '
      + String((scenario.durationMs ?? 0) / 1000) + 's]: ' + detail)
  }
  lines.push('')
  lines.push('## Docker build/boot/backup/restore smoke')
  lines.push('')
  if (dockerReport !== null) {
    const evidence = dockerReport.evidence ?? {}
    lines.push('- Evidence JSON: `docs/superpowers/acceptance/artifacts/c12-docker/docker-smoke-report.json`')
    lines.push('- Result: **' + String(dockerReport.result) + '**')
    lines.push('- Tested code revision: `' + String(dockerReport.codeRevision ?? 'missing') + '`')
    lines.push('- Image built: `' + String(evidence.imageBuilt === true) + '`')
    lines.push('- Container booted and `/readyz` ready: `' + String(evidence.readyzReady === true) + '`')
    lines.push('- WAL/full: `' + String(evidence.journalMode) + '` / `' + String(evidence.synchronous) + '`')
    lines.push('- Non-root uid: `' + String(evidence.uid ?? 'missing') + '`')
    lines.push('- Backup content asserted: `' + String(evidence.backupContentAsserted === true) + '`')
    lines.push('- Restore content matched: `' + String(evidence.restoreContentMatched === true) + '`')
    lines.push('- Post-restore readiness: `' + String(evidence.postRestoreReadyz === true) + '`')
    lines.push('- Teardown completed: `' + String(evidence.teardown === true) + '`')
  } else {
    lines.push('No Docker smoke JSON report was produced; the gate is failed.')
  }
  lines.push('')
  lines.push('## TLS/WSS reverse-proxy smoke')
  lines.push('')
  if (proxyReport !== null) {
    const evidence = proxyReport.evidence ?? {}
    lines.push('- Evidence JSON: `docs/superpowers/acceptance/artifacts/c12-proxy/proxy-smoke-report.json`')
    lines.push('- Result: **' + String(proxyReport.result) + '**')
    lines.push('- Tested code revision: `' + String(proxyReport.codeRevision ?? 'missing') + '`')
    lines.push('- Nginx proxy: `' + String(evidence.nginxProxy === true) + '`')
    lines.push('- Self-signed TLS terminated: `' + String(evidence.tlsTerminated === true) + '`')
    lines.push('- Authenticated WSS upgrade: `' + String(evidence.authenticatedOverWss === true) + '`')
    lines.push('- `/v1/sync` route: `' + String(evidence.v1SyncRoute === true) + '`')
    lines.push('- `/sync` alias route and authenticated upgrade: `' + String(evidence.syncRoute === true && evidence.syncAliasUpgrade === true && evidence.syncAliasAuthenticated === true) + '`')
    lines.push('- `/health`, `/healthz`, `/readyz`: `' + String(evidence.healthRoute === true) + '`, `' + String(evidence.healthzRoute === true) + '`, `' + String(evidence.readyzRoute === true) + '`')
  } else {
    lines.push('No TLS/WSS proxy smoke JSON report was produced; the gate is failed.')
  }
  const failures = results.filter(result => result.code !== 0)
  if (failures.length > 0) {
    lines.push('')
    lines.push('## Failure output')
    lines.push('')
    for (const result of failures) {
      lines.push('### ' + result.label + ' (`exit ' + result.code + '`)')
      lines.push('')
      if (result.error) {
        lines.push(fence(result.error))
        lines.push('')
      }
      lines.push(fence(tail((result.stdout + result.stderr).trim() || '(no output)')))
      lines.push('')
    }
  }
  await writeFile(REPORT_PATH, lines.join('\n') + '\n')
  process.stdout.write('\n[gate] report: ' + REPORT_PATH + '\n')
  process.stdout.write('[gate] RESULT: ' + finalStatus + '\n')
  if (allPassed === false) process.exitCode = 1
}

main().catch(error => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  process.stderr.write('[gate] FAILED TO RUN: ' + message + '\n')
  process.exitCode = 1
})

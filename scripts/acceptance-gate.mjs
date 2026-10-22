/**
 * C12 final acceptance gate.
 *
 * Runs the release-blocking commands in one place and writes concise evidence
 * to docs/superpowers/acceptance/. Local mode and mobile server-mode hiding are
 * checked by the existing root typecheck/compat/build commands; the real-server
 * Electron E2E is run separately and its JSON evidence is copied alongside the
 * report.
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const STAMP = new Date().toISOString()
const DATE = STAMP.slice(0, 10)
const ACCEPTANCE_DIR = join(ROOT, 'docs/superpowers/acceptance')
const REPORT_PATH = join(ACCEPTANCE_DIR, DATE + '-c12-final-gate.md')
const E2E_ARTIFACT_DIR = join(ACCEPTANCE_DIR, 'artifacts/c12-e2e')
const E2E_REPORT_PATH = join(E2E_ARTIFACT_DIR, 'c12-e2e-report.json')
const FAILURE_TAIL_CHARS = 4000

function runGit(args) {
  return new Promise(resolveRun => {
    const child = spawn('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('close', code => resolveRun({ code, stdout: stdout.trim(), stderr: stderr.trim() }))
  })
}

function runCommand(label, command, args, options = {}) {
  return new Promise(resolveRun => {
    const startedAt = Date.now()
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
      resolveRun({
        label,
        command: [command, ...args].join(' '),
        code: -1,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        error: error.message,
      })
    })
    child.once('close', code => {
      const result = {
        label,
        command: [command, ...args].join(' '),
        code,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
      }
      process.stdout.write('[gate] <<< ' + label + ' exit=' + code + ' (' + result.durationMs + 'ms)\n')
      resolveRun(result)
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

async function main() {
  await mkdir(ACCEPTANCE_DIR, { recursive: true })
  await mkdir(E2E_ARTIFACT_DIR, { recursive: true })
  const revision = await runGit(['rev-parse', 'HEAD'])
  const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'])
  const dirtyBefore = await runGit(['status', '--porcelain'])
  const results = []
  const steps = [
    { label: 'root typecheck', command: 'npm', args: ['run', 'typecheck'] },
    { label: 'root compatibility tests', command: 'npm', args: ['run', 'test:compat'] },
    { label: 'desktop build', command: 'npm', args: ['run', 'build'] },
    { label: 'Android web build', command: 'npm', args: ['run', 'build:android-web'] },
    { label: 'Harmony web build', command: 'npm', args: ['run', 'build:harmony-web'] },
    { label: 'iOS web build', command: 'npm', args: ['run', 'build:ios-web'] },
    { label: 'server typecheck', command: NPM, args: ['--prefix', 'server', 'run', 'typecheck'] },
    { label: 'server tests', command: NPM, args: ['--prefix', 'server', 'test'] },
    {
      label: 'real-server two-Electron E2E',
      command: NPM,
      args: ['run', 'test:e2e'],
      env: { QQPET_E2E_ARTIFACTS: E2E_ARTIFACT_DIR },
    },
  ]

  for (const step of steps) {
    const result = await runCommand(step.label, step.command, step.args, { env: step.env })
    results.push(result)
    if (result.code !== 0) break
  }

  let e2eReport = null
  try {
    e2eReport = JSON.parse(await readFile(E2E_REPORT_PATH, 'utf8'))
  } catch {
    e2eReport = null
  }
  // Keep the concise machine-readable evidence, not multi-process debug logs.
  await rm(join(E2E_ARTIFACT_DIR, 'c12-server.log'), { force: true })
  await rm(join(E2E_ARTIFACT_DIR, 'c12-owner-harness.log'), { force: true })

  const allPassed = results.length === steps.length && results.every(result => result.code === 0)
  const finalStatus = allPassed ? 'PASS' : 'FAIL'
  const lines = []
  lines.push('# C12 final acceptance gate')
  lines.push('')
  lines.push('- Result: **' + finalStatus + '**')
  lines.push('- Generated at: `' + STAMP + '`')
  lines.push('- Branch: `' + branch.stdout + '`')
  lines.push('- Code revision under test: `' + revision.stdout + '`')
  lines.push('- Working tree before gate: ' + (dirtyBefore.stdout.length === 0
    ? 'clean'
    : 'dirty (evidence reflects the checked-out working tree, not a tagged release)'))
  lines.push('- Runtime: Node `' + process.version + '`, `' + process.platform + '/' + process.arch + '`')
  lines.push('- GUI coverage: **not claimed**. The E2E launches two real Electron main processes'
    + ' and the production RemoteRepository/WebSocket transport without a BrowserWindow.'
    + ' Renderer/preload/visual GUI automation is a documented residual gap.')
  lines.push('')
  lines.push('## Commands and results')
  lines.push('')
  lines.push(markdownRow(['#', 'Command', 'Result', 'Duration']))
  lines.push(markdownRow(['---', '---', '---', '---:']))
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]
    lines.push(markdownRow([
      String(index + 1),
      '`' + result.command + '`',
      result.code === 0 ? 'PASS' : 'FAIL (' + result.code + ')',
      String((result.durationMs / 1000).toFixed(1)) + 's',
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
  if (e2eReport !== null) {
    lines.push('## Real-server Electron E2E evidence')
    lines.push('')
    lines.push('- Evidence JSON: `docs/superpowers/acceptance/artifacts/c12-e2e/c12-e2e-report.json`')
    lines.push('- Result: **' + String(e2eReport.result).toUpperCase() + '**')
    lines.push('- Two Electron processes: `' + String(e2eReport.evidence?.twoProcesses === true) + '`')
    lines.push('- Real standalone server: `' + String(e2eReport.evidence?.realStandaloneServer === true) + '`')
    lines.push('- Real WebSocket: `' + String(e2eReport.evidence?.realWebSocket === true) + '`')
    lines.push('- GUI coverage: `' + String(e2eReport.evidence?.guiCoverage === true) + '`')
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
    const detailByStep = new Map((e2eReport.steps ?? []).map(step => [step.name, step.detail]))
    const selected = [
      'first-run adopt on empty server and two-client convergence',
      'feed on instance A updates inventory/task and reaches instance B within 3s',
      'lost command result reconciles via commandStatus after reconnect without resend',
      'revision gap triggers resync and full snapshot convergence',
      'device revoke closes the player Electron connection and preserves owner projection',
      'authority detach and resume recover to a full authoritative snapshot',
      'server restart catch-up preserves state and advances game time',
      'authority_reset_required after operator restore recovers to a full snapshot',
    ]
    lines.push('')
    lines.push('### Selected hash/revision evidence')
    lines.push('')
    for (const name of selected) {
      const detail = detailByStep.get(name)
      if (detail === undefined) continue
      const compact = JSON.stringify(detail)
      lines.push('- `' + name + '`: `' + compact + '`')
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

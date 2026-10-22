/**
 * Real Docker release smoke.
 *
 * Builds the production image, initializes and serves a temporary volume,
 * proves readiness/WAL/FULL/non-root runtime, then runs an online backup,
 * mutates the live DB, restores the backup and asserts the original content and
 * restore-generation fence. It writes machine-readable evidence for the gate.
 */
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DOCKER = process.env.DOCKER ?? 'docker'
const STARTED_AT_MS = Date.now()
const STARTED_AT = new Date(STARTED_AT_MS).toISOString()
const REPORT_PATH = process.env.QQPET_DOCKER_SMOKE_REPORT
  ?? join(ROOT, 'docs/superpowers/acceptance/artifacts/c12-docker/docker-smoke-report.json')
const CODE_REVISION = process.env.QQPET_CODE_REVISION?.trim() || gitRevision()
const IMAGE = process.env.QQPET_SMOKE_IMAGE?.trim()
  || 'qqpet-server:smoke-' + process.pid + '-' + STARTED_AT_MS
const KEEP_IMAGE = process.env.QQPET_KEEP_SMOKE_IMAGE === '1'
const SUFFIX = process.pid + '-' + STARTED_AT_MS
const CONTAINER = 'qqpet-docker-smoke-' + SUFFIX
const VOLUME = 'qqpet-docker-smoke-' + SUFFIX
const DB_PATH = '/var/lib/qqpet-sync/qqpet.sqlite'
const BACKUP_PATH = '/var/lib/qqpet-sync/smoke-backup.sqlite'
const CREDENTIAL_PATH = '/run/secrets/owner_admin_credential'
const RESTORE_GENERATION_PATH = '/var/lib/qqpet-sync/restore-generation.txt'
const MAX_OUTPUT_CHARS = 12_000
let credentialFile = ''

function gitRevision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function tail(text, max = MAX_OUTPUT_CHARS) {
  if (text.length <= max) return text
  return text.slice(text.length - max)
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const startedAt = Date.now()
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', error => reject(new Error(error.message + '\n$ ' + [command, ...args].join(' '))))
    child.once('close', code => {
      const result = { code, stdout, stderr, durationMs: Date.now() - startedAt }
      if (code === 0) {
        resolveRun(result)
        return
      }
      reject(new Error('command failed (' + String(code) + '): ' + [command, ...args].join(' ')
        + '\n' + tail((stdout + stderr).trim())))
    })
  })
}

async function bestEffort(command, args) {
  try {
    await run(command, args)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function parseJsonOutput(text) {
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first < 0 || last <= first) throw new Error('expected JSON output, got: ' + tail(text, 1000))
  return JSON.parse(text.slice(first, last + 1))
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('could not allocate loopback port'))
        return
      }
      const port = address.port
      server.close(error => error === undefined ? resolvePort(port) : reject(error))
    })
  })
}

const INSPECT_DB_SCRIPT = `
const { createHash } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(process.env.QQPET_SMOKE_DB, { readOnly: true })
try {
  const quick = db.prepare('PRAGMA quick_check').get()
  const quickCheck = String(Object.values(quick)[0] ?? '')
  const pet = db.prepare('SELECT id, revision, event_seq, game_time_ms, save_json FROM pets WHERE id = ?').get('default')
  if (pet === undefined) throw new Error('default pet missing from database')
  const save = JSON.parse(pet.save_json)
  const authority = db.prepare('SELECT authority_id, restore_generation, epoch, state FROM pet_authority WHERE pet_id = ?').get('default')
  console.log(JSON.stringify({
    quickCheck,
    petId: String(pet.id),
    revision: Number(pet.revision),
    eventSeq: Number(pet.event_seq),
    gameTimeMs: Number(pet.game_time_ms),
    saveBytes: Buffer.byteLength(pet.save_json),
    saveSha256: createHash('sha256').update(pet.save_json).digest('hex'),
    saveObjectKeys: Object.keys(save).sort(),
    authorityId: String(authority?.authority_id ?? ''),
    restoreGeneration: Number(authority?.restore_generation ?? -1),
    authorityEpoch: Number(authority?.epoch ?? -1),
    authorityState: String(authority?.state ?? ''),
  }))
} finally {
  db.close()
}
`

const MUTATE_DB_SCRIPT = `
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(process.env.QQPET_SMOKE_DB)
try {
  const result = db.prepare('UPDATE pets SET revision = revision + 1000, event_seq = event_seq + 1000, updated_at_ms = updated_at_ms + 1000 WHERE id = ?').run('default')
  if (Number(result.changes) === 0) throw new Error('mutation affected no pet')
  console.log(JSON.stringify({ ok: true, changed: Number(result.changes) }))
} finally {
  db.close()
}
`

async function inspectRunning(containerId, dbPath = DB_PATH) {
  const result = await run(DOCKER, [
    'exec', '-e', 'QQPET_SMOKE_DB=' + dbPath, containerId,
    'node', '-e', INSPECT_DB_SCRIPT,
  ])
  return parseJsonOutput(result.stdout)
}

async function inspectStoppedVolume(dbPath = DB_PATH) {
  const result = await run(DOCKER, [
    'run', '--rm', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
    '-v', VOLUME + ':/var/lib/qqpet-sync',
    '-e', 'QQPET_SMOKE_DB=' + dbPath,
    '--entrypoint', 'node', IMAGE, '-e', INSPECT_DB_SCRIPT,
  ])
  return parseJsonOutput(result.stdout)
}

function assertContent(label, actual, expected) {
  if (actual.quickCheck !== 'ok') throw new Error(label + ': sqlite quick_check is ' + actual.quickCheck)
  if (actual.petId !== expected.petId) throw new Error(label + ': pet id changed')
  if (actual.saveSha256 !== expected.saveSha256) throw new Error(label + ': canonical save content changed')
  if (actual.saveBytes !== expected.saveBytes) throw new Error(label + ': canonical save byte length changed')
  if (actual.revision !== expected.revision) throw new Error(label + ': revision changed: ' + actual.revision + ' versus ' + expected.revision)
  if (actual.eventSeq !== expected.eventSeq) throw new Error(label + ': event sequence changed')
}

async function waitForReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/readyz')
      const body = await response.json()
      if (response.ok && body.ready === true) return body
      lastError = 'status ' + response.status + ' ready=' + String(body.ready)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(100)
  }
  throw new Error('container did not become ready: ' + lastError)
}

async function startContainer(port) {
  const result = await run(DOCKER, [
    'run', '-d', '--name', CONTAINER,
    '--read-only',
    '--security-opt', 'no-new-privileges:true',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
    '-v', VOLUME + ':/var/lib/qqpet-sync',
    '-v', credentialFile + ':' + CREDENTIAL_PATH + ':ro',
    '-e', 'QQPET_SYNC_DB=' + DB_PATH,
    '-e', 'QQPET_SYNC_BACKUP_DIR=/var/lib/qqpet-sync/backups',
    '-e', 'QQPET_SYNC_RESTORE_GENERATION_FILE=' + RESTORE_GENERATION_PATH,
    '-e', 'QQPET_OWNER_ADMIN_CREDENTIAL=' + CREDENTIAL_PATH,
    '-e', 'QQPET_SYNC_ADVANCE_WHILE_EMPTY=0',
    '-p', '127.0.0.1:' + port + ':8787',
    IMAGE,
  ])
  return result.stdout.trim()
}

async function main() {
  const report = {
    schemaVersion: 1,
    startedAt: STARTED_AT,
    codeRevision: CODE_REVISION,
    result: 'FAIL',
    image: IMAGE,
    evidence: {
      imageBuilt: false,
      containerStarted: false,
      readyzReady: false,
      journalMode: 'unknown',
      synchronous: 'unknown',
      nonRoot: false,
      uid: 0,
      backupCreated: false,
      backupContentAsserted: false,
      restoreSucceeded: false,
      restoreContentMatched: false,
      postRestoreReadyz: false,
      teardown: false,
    },
  }
  let builtImage = false
  let containerId = ''
  let volumeCreated = false
  let tempDir = ''
  let cleanupErrors = []
  try {
    if (CODE_REVISION.length === 0) throw new Error('could not resolve current git revision')
    await mkdir(join(ROOT, 'out'), { recursive: true })
    tempDir = await mkdtemp(join(ROOT, 'out/docker-smoke-'))
    credentialFile = join(tempDir, 'owner-admin-credential')
    await writeFile(credentialFile, 'docker-smoke-' + randomBytes(32).toString('hex') + '\n', { mode: 0o600 })

    if (process.env.QQPET_SMOKE_IMAGE?.trim()) {
      report.evidence.imageBuilt = true
    } else {
      process.stdout.write('[docker-smoke] building ' + IMAGE + '\n')
      await run(DOCKER, ['build', '-f', 'server/Dockerfile', '-t', IMAGE, '.'])
      builtImage = true
      report.evidence.imageBuilt = true
    }

    await run(DOCKER, ['volume', 'create', VOLUME])
    volumeCreated = true
    const init = await run(DOCKER, [
      'run', '--rm', '--name', CONTAINER + '-init',
      '-v', VOLUME + ':/var/lib/qqpet-sync',
      '-e', 'QQPET_SYNC_ADVANCE_WHILE_EMPTY=0',
      '--entrypoint', 'node', IMAGE,
      'dist/server/src/index.js', 'init',
      '--db', DB_PATH, '--pet-id', 'default', '--time-zone', 'UTC', '--weather-city', 'Smoke City',
    ])
    const initialized = parseJsonOutput(init.stdout)
    if (initialized.ok === true) { /* expected */ } else { throw new Error('init did not return ok:true') }
    report.evidence.initializedPetId = String(initialized.petId)
    report.evidence.initialAuthorityId = String(initialized.authority?.authorityId ?? '')
    process.stdout.write('[docker-smoke] image built and volume initialized\n')

    const port = await freePort()
    containerId = await startContainer(port)
    report.evidence.containerStarted = true
    const health = await waitForReady(port, 30_000)
    if (health.journalMode !== 'wal') throw new Error('readiness journalMode is not wal: ' + String(health.journalMode))
    if (health.synchronous !== 'full') throw new Error('readiness synchronous is not full: ' + String(health.synchronous))
    report.evidence.readyzReady = health.ready === true
    report.evidence.journalMode = String(health.journalMode)
    report.evidence.synchronous = String(health.synchronous)

    const uidOutput = await run(DOCKER, ['exec', containerId, 'id', '-u'])
    const uid = Number(uidOutput.stdout.trim())
    if (Number.isSafeInteger(uid) === false || uid === 0) {
      throw new Error('container runtime uid is not a non-root integer: ' + uidOutput.stdout.trim())
    }
    report.evidence.uid = uid
    report.evidence.nonRoot = true

    const before = await inspectRunning(containerId)
    if (before.quickCheck !== 'ok') throw new Error('live database quick_check is ' + before.quickCheck)
    if (before.saveObjectKeys.length === 0) throw new Error('canonical save has no content keys')
    process.stdout.write('[docker-smoke] ready: wal/full, uid=' + uid + ', revision=' + before.revision + '\n')

    const backup = await run(DOCKER, [
      'exec', containerId, 'node', 'dist/server/src/index.js', 'backup',
      '--db', DB_PATH, '--pet-id', 'default', '--output', BACKUP_PATH,
    ])
    const backupJson = parseJsonOutput(backup.stdout)
    if (backupJson.ok === true) {
      report.evidence.backupCreated = true
    } else {
      throw new Error('backup did not return ok:true')
    }
    const backupInspect = await inspectRunning(containerId, BACKUP_PATH)
    assertContent('backup copy', backupInspect, before)
    report.evidence.backupContentAsserted = true
    report.evidence.backupRevision = backupInspect.revision
    report.evidence.backupSaveSha256 = backupInspect.saveSha256
    process.stdout.write('[docker-smoke] backup content asserted at revision ' + backupInspect.revision + '\n')

    await run(DOCKER, ['stop', '--time', '20', containerId])
    await run(DOCKER, ['rm', containerId])
    containerId = ''
    process.stdout.write('[docker-smoke] backup complete; server stopped for restore drill\n')

    const mutate = await run(DOCKER, [
      'run', '--rm', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
      '-v', VOLUME + ':/var/lib/qqpet-sync',
      '-e', 'QQPET_SMOKE_DB=' + DB_PATH,
      '--entrypoint', 'node', IMAGE, '-e', MUTATE_DB_SCRIPT,
    ])
    const mutated = parseJsonOutput(mutate.stdout)
    if (mutated.ok === true) { /* expected */ } else { throw new Error('post-backup mutation failed') }
    const changed = await inspectStoppedVolume()
    if (changed.revision === before.revision) throw new Error('post-backup mutation did not change revision')
    if (changed.saveSha256 !== before.saveSha256) throw new Error('mutation unexpectedly changed canonical save content')
    report.evidence.postBackupRevision = changed.revision

    const restore = await run(DOCKER, [
      'run', '--rm', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
      '-v', VOLUME + ':/var/lib/qqpet-sync',
      '-v', credentialFile + ':' + CREDENTIAL_PATH + ':ro',
      '-e', 'QQPET_SYNC_RESTORE_GENERATION_FILE=' + RESTORE_GENERATION_PATH,
      '-e', 'QQPET_OWNER_ADMIN_CREDENTIAL=' + CREDENTIAL_PATH,
      '--entrypoint', 'node', IMAGE,
      'dist/server/src/index.js', 'restore',
      '--db', DB_PATH, '--from', BACKUP_PATH, '--accept-rollback',
      '--owner-admin-credential', CREDENTIAL_PATH, '--restore-generation', '1',
    ])
    const restoreJson = parseJsonOutput(restore.stdout)
    if (restoreJson.ok === true) {
      report.evidence.restoreSucceeded = true
    } else {
      throw new Error('restore did not return ok:true')
    }

    const restored = await inspectStoppedVolume()
    assertContent('restored database', restored, before)
    if (restored.restoreGeneration !== 1) {
      throw new Error('restored authority generation is ' + restored.restoreGeneration + ' instead of 1')
    }
    if (restored.authorityId === before.authorityId) throw new Error('restore did not rotate authority id')
    report.evidence.restoreContentMatched = true
    report.evidence.restoredAuthorityId = restored.authorityId
    report.evidence.restoreGeneration = restored.restoreGeneration
    process.stdout.write('[docker-smoke] restore content matched backup; authority generation=1\n')

    containerId = await startContainer(port)
    const postHealth = await waitForReady(port, 30_000)
    if (postHealth.ready === true) { /* expected */ } else { throw new Error('post-restore readiness did not report ready') }
    if (postHealth.restoreGeneration !== 1) {
      throw new Error('post-restore readiness generation is ' + String(postHealth.restoreGeneration))
    }
    report.evidence.postRestoreReadyz = true
    report.evidence.postRestoreJournalMode = String(postHealth.journalMode)
    report.evidence.postRestoreSynchronous = String(postHealth.synchronous)
    await run(DOCKER, ['stop', '--time', '20', containerId])
    process.stdout.write('[docker-smoke] post-restore server booted ready\n')
    report.result = 'PASS'
  } catch (error) {
    report.result = 'FAIL'
    report.error = error instanceof Error ? error.stack ?? error.message : String(error)
    process.stderr.write('[docker-smoke] FAILED: ' + report.error + '\n')
    process.exitCode = 1
  } finally {
    if (containerId.length > 0) {
      const error = await bestEffort(DOCKER, ['rm', '-f', containerId])
      if (error) cleanupErrors.push(error)
      containerId = ''
    }
    if (volumeCreated) {
      const error = await bestEffort(DOCKER, ['volume', 'rm', VOLUME])
      if (error) cleanupErrors.push(error)
    }
    if (builtImage && KEEP_IMAGE === false) {
      const error = await bestEffort(DOCKER, ['image', 'rm', '-f', IMAGE])
      if (error) cleanupErrors.push(error)
    }
    if (tempDir.length > 0) {
      try {
        await rm(tempDir, { recursive: true, force: true })
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error))
      }
    }
    report.evidence.teardown = cleanupErrors.length === 0
    if (cleanupErrors.length > 0) {
      report.cleanupErrors = cleanupErrors
      report.result = 'FAIL'
      process.exitCode = 1
    }
    report.finishedAt = new Date().toISOString()
    await mkdir(dirname(REPORT_PATH), { recursive: true })
    await writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + '\n')
    process.stdout.write('C12_DOCKER_SMOKE_RESULT ' + JSON.stringify({
      result: report.result,
      report: REPORT_PATH,
      revision: report.codeRevision,
    }) + '\n')
  }
}

main().catch(error => {
  process.stderr.write('[docker-smoke] FAILED TO RUN: ' + (error instanceof Error ? error.stack ?? error.message : String(error)) + '\n')
  process.exitCode = 1
})

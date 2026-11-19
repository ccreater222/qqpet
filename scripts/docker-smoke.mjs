/**
 * Real Docker release smoke.
 *
 * Builds the production image, initializes and serves a temporary volume,
 * proves readiness/WAL/FULL/non-root runtime plus uid-1000 readability of a
 * hashed owner credential, then runs an online backup, mutates the live DB,
 * restores the backup and asserts the original content and restore-generation
 * fence. It writes machine-readable evidence for the gate.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
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
  ?? join(ROOT, '.agent-reports/acceptance/artifacts/c12-docker/docker-smoke-report.json')
const CODE_REVISION = process.env.QQPET_CODE_REVISION?.trim() || gitRevision()
const IMAGE = process.env.QQPET_SMOKE_IMAGE?.trim()
  || 'qqpet-server:smoke-' + process.pid + '-' + STARTED_AT_MS
const KEEP_IMAGE = process.env.QQPET_KEEP_SMOKE_IMAGE === '1'
const SUFFIX = process.pid + '-' + STARTED_AT_MS
const CONTAINER = 'qqpet-docker-smoke-' + SUFFIX
const VOLUME = 'qqpet-docker-smoke-' + SUFFIX
const DB_PATH = '/var/lib/qqpet-sync/qqpet.sqlite'
const BACKUP_PATH = '/var/lib/qqpet-sync/smoke-backup.sqlite'
const CREDENTIAL_SOURCE_PATH = '/run/secrets/owner_admin_credential'
const CREDENTIAL_RUNTIME_PATH = '/run/qqpet-secrets/owner_admin_credential'
const CREDENTIAL_RUNTIME_DIR = '/run/qqpet-secrets'
const SECRET_ENTRYPOINT = '/usr/local/bin/qqpet-docker-entrypoint.sh'
const RESTORE_GENERATION_PATH = '/var/lib/qqpet-sync/restore-generation.txt'
const MAX_OUTPUT_CHARS = 12_000
let credentialFile = ''
let ownerAdminCredential = ''

function gitRevision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const hashIdentifier = value => createHash('sha256').update(String(value)).digest('hex')

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

const CREATE_OWNER_SCRIPT = `
import { openDatabase } from './dist/server/src/db.js'
const store = openDatabase(process.env.QQPET_SMOKE_DB)
try {
  const created = store.createDevice(process.env.QQPET_SMOKE_PET_ID, 'docker-smoke-owner', 'owner')
  const row = store.db.prepare('SELECT length(token_hash) AS hash_bytes, hex(token_hash) AS hash_hex FROM devices WHERE pet_id = ? AND device_id = ?').get(process.env.QQPET_SMOKE_PET_ID, created.device.deviceId)
  if (row === undefined) throw new Error('created owner device is missing')
  if (Number(row.hash_bytes) !== 32) throw new Error('owner token hash is not 32 bytes')
  if (String(row.hash_hex) === created.token) throw new Error('owner credential was stored in plaintext')
  console.log(JSON.stringify({ ok: true, token: created.token, deviceId: created.device.deviceId, tokenHashBytes: Number(row.hash_bytes) }))
} finally {
  store.close()
}
`

const PROCESS_UID_SCRIPT = `
const fs = require('node:fs')
const status = fs.readFileSync('/proc/1/status', 'utf8')
const match = /^Uid:[^0-9]*([0-9]+)/m.exec(status)
if (match === null) throw new Error('runtime uid is missing from /proc/1/status')
console.log(match[1])
`

const READ_CREDENTIAL_SCRIPT = `
const fs = require('node:fs')
const path = process.env.QQPET_OWNER_ADMIN_CREDENTIAL
if (path === undefined || path.length === 0) throw new Error('runtime owner credential path is not configured')
const info = fs.statSync(path)
const value = fs.readFileSync(path, 'utf8').trim()
if (value.length === 0) throw new Error('runtime owner credential is empty')
if (info.uid !== process.getuid()) throw new Error('runtime owner credential owner uid mismatch')
if ((info.mode & 0o077) !== 0) throw new Error('runtime owner credential is group/world accessible')
console.log(JSON.stringify({ readable: true, uid: process.getuid(), mode: info.mode & 0o777, bytes: Buffer.byteLength(value) }))
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

async function inspectRunning(containerId, uid, dbPath = DB_PATH) {
  const result = await run(DOCKER, [
    'exec', '--user', String(uid), '-e', 'QQPET_SMOKE_DB=' + dbPath, containerId,
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
    '--user', '0:0',
    '--security-opt', 'no-new-privileges:true',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
    '--tmpfs', CREDENTIAL_RUNTIME_DIR + ':rw,noexec,nosuid,size=64k,mode=0700',
    '-v', VOLUME + ':/var/lib/qqpet-sync',
    '-v', credentialFile + ':' + CREDENTIAL_SOURCE_PATH + ':ro',
    '-e', 'QQPET_SYNC_DB=' + DB_PATH,
    '-e', 'QQPET_SYNC_BACKUP_DIR=/var/lib/qqpet-sync/backups',
    '-e', 'QQPET_SYNC_RESTORE_GENERATION_FILE=' + RESTORE_GENERATION_PATH,
    '-e', 'QQPET_OWNER_ADMIN_CREDENTIAL=' + CREDENTIAL_RUNTIME_PATH,
    '-e', 'QQPET_OWNER_ADMIN_CREDENTIAL_SOURCE=' + CREDENTIAL_SOURCE_PATH,
    '-e', 'QQPET_SYNC_ADVANCE_WHILE_EMPTY=0',
    '-p', '127.0.0.1:' + port + ':8787',
    '--entrypoint', '/bin/sh',
    IMAGE, SECRET_ENTRYPOINT, 'start',
  ])
  return result.stdout.trim()
}

async function runtimeProcessUid(containerId) {
  const result = await run(DOCKER, ['exec', containerId, 'node', '-e', PROCESS_UID_SCRIPT])
  return Number(result.stdout.trim())
}

async function assertRuntimeCredentialReadable(containerId, uid) {
  const result = await run(DOCKER, [
    'exec', '--user', String(uid), containerId, 'node', '-e', READ_CREDENTIAL_SCRIPT,
  ])
  return parseJsonOutput(result.stdout)
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
      ownerAdminCredentialHashed: false,
      credentialReadableByRuntime: false,
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
    report.evidence.initialAuthorityIdHash = hashIdentifier(initialized.authority?.authorityId ?? '')
    const owner = await run(DOCKER, [
      'run', '--rm', '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
      '-v', VOLUME + ':/var/lib/qqpet-sync',
      '-e', 'QQPET_SMOKE_DB=' + DB_PATH,
      '-e', 'QQPET_SMOKE_PET_ID=default',
      '--entrypoint', 'node', IMAGE, '--input-type=module', '-e', CREATE_OWNER_SCRIPT,
    ])
    const createdOwner = parseJsonOutput(owner.stdout)
    if (createdOwner.ok !== true || typeof createdOwner.token !== 'string' || createdOwner.token.length < 43) {
      throw new Error('could not create a real hashed owner credential in the smoke database')
    }
    if (createdOwner.tokenHashBytes !== 32) {
      throw new Error('smoke owner credential hash is not 32 bytes')
    }
    ownerAdminCredential = createdOwner.token
    await writeFile(credentialFile, ownerAdminCredential + '\n', { mode: 0o600 })
    report.evidence.ownerAdminDeviceIdHash = hashIdentifier(createdOwner.deviceId)
    report.evidence.ownerAdminCredentialHashed = true
    process.stdout.write('[docker-smoke] image built, volume initialized and owner credential hashed\n')

    const port = await freePort()
    containerId = await startContainer(port)
    report.evidence.containerStarted = true
    const readyz = await waitForReady(port, 30_000)
    report.evidence.readyzReady = readyz.ready === true
    // Public /readyz intentionally omits operational PRAGMA detail. Prove it
    // through the owner-authenticated detailed-health route using the same
    // hashed owner credential that will authorize restore.
    const healthResponse = await fetch('http://127.0.0.1:' + port + '/health/detail', {
      headers: { authorization: 'Bearer ' + ownerAdminCredential },
    })
    const health = await healthResponse.json()
    if (healthResponse.ok === false || health.ready !== true) {
      throw new Error('owner-authenticated detailed health is not ready: status ' + healthResponse.status)
    }
    if (health.journalMode !== 'wal') throw new Error('readiness journalMode is not wal: ' + String(health.journalMode))
    if (health.synchronous !== 'full') throw new Error('readiness synchronous is not full: ' + String(health.synchronous))
    report.evidence.journalMode = String(health.journalMode)
    report.evidence.synchronous = String(health.synchronous)

    const uid = await runtimeProcessUid(containerId)
    if (Number.isSafeInteger(uid) === false || uid === 0) {
      throw new Error('container runtime uid is not a non-root integer: ' + uid)
    }
    report.evidence.uid = uid
    report.evidence.nonRoot = true
    const credentialRead = await assertRuntimeCredentialReadable(containerId, uid)
    if (credentialRead.readable !== true || credentialRead.uid !== uid) {
      throw new Error('container runtime could not read the owner credential as its own uid')
    }
    report.evidence.credentialReadableByRuntime = true
    report.evidence.credentialRuntimeUid = credentialRead.uid
    report.evidence.credentialRuntimeMode = credentialRead.mode

    const before = await inspectRunning(containerId, uid)
    if (before.quickCheck !== 'ok') throw new Error('live database quick_check is ' + before.quickCheck)
    if (before.saveObjectKeys.length === 0) throw new Error('canonical save has no content keys')
    process.stdout.write('[docker-smoke] ready: wal/full, uid=' + uid + ', revision=' + before.revision + '\n')

    const backup = await run(DOCKER, [
      'exec', '--user', String(uid), containerId, 'node', 'dist/server/src/index.js', 'backup',
      '--db', DB_PATH, '--pet-id', 'default', '--output', BACKUP_PATH,
    ])
    const backupJson = parseJsonOutput(backup.stdout)
    if (backupJson.ok === true) {
      report.evidence.backupCreated = true
    } else {
      throw new Error('backup did not return ok:true')
    }
    const backupInspect = await inspectRunning(containerId, uid, BACKUP_PATH)
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
      'run', '--rm', '--read-only', '--user', '0:0',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
      '--tmpfs', CREDENTIAL_RUNTIME_DIR + ':rw,noexec,nosuid,size=64k,mode=0700',
      '-v', VOLUME + ':/var/lib/qqpet-sync',
      '-v', credentialFile + ':' + CREDENTIAL_SOURCE_PATH + ':ro',
      '-e', 'QQPET_SYNC_RESTORE_GENERATION_FILE=' + RESTORE_GENERATION_PATH,
      '-e', 'QQPET_OWNER_ADMIN_CREDENTIAL=' + CREDENTIAL_RUNTIME_PATH,
      '-e', 'QQPET_OWNER_ADMIN_CREDENTIAL_SOURCE=' + CREDENTIAL_SOURCE_PATH,
      '--entrypoint', '/bin/sh', IMAGE, SECRET_ENTRYPOINT,
      'restore',
      '--db', DB_PATH, '--from', BACKUP_PATH, '--accept-rollback',
      '--owner-admin-credential', CREDENTIAL_RUNTIME_PATH, '--restore-generation', '1',
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
    report.evidence.restoredAuthorityIdHash = hashIdentifier(restored.authorityId)
    report.evidence.restoreGeneration = restored.restoreGeneration
    process.stdout.write('[docker-smoke] restore content matched backup; authority generation=1\n')

    containerId = await startContainer(port)
    const postReadyz = await waitForReady(port, 30_000)
    if (postReadyz.ready !== true) throw new Error('post-restore readiness did not report ready')
    const postHealthResponse = await fetch('http://127.0.0.1:' + port + '/health/detail', {
      headers: { authorization: 'Bearer ' + ownerAdminCredential },
    })
    const postHealth = await postHealthResponse.json()
    if (postHealthResponse.ok === false || postHealth.ready !== true) {
      throw new Error('post-restore owner-authenticated detailed health did not report ready')
    }
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

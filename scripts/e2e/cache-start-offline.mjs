/**
 * Focused real Electron + real standalone server outage test.
 *
 * It proves the cache-first startup contract added for server mode:
 *   1. an online owner renderer creates a validated projection cache;
 *   2. the server is stopped and the app is relaunched with the same user-data;
 *   3. the renderer opens read-only from the cache without waiting for the server;
 *   4. commands are rejected with `offline`, never applied locally;
 *   5. after the server returns, the same renderer reconnects and a command applies.
 *
 * Run from the repository root after `npm run build` and `npm --prefix server run build`.
 * Set QQPET_E2E_ROOT when invoking this file from a worktree against a built checkout.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const HERE = new URL('.', import.meta.url).pathname
const ROOT = resolve(process.env.QQPET_E2E_ROOT ?? join(HERE, '../..'))
const SERVER = join(ROOT, 'server/dist/server/src/index.js')
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms))

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') return reject(new Error('no free port'))
      probe.close(error => error === undefined ? resolvePort(address.port) : reject(error))
    })
  })
}

async function waitFor(check, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(100)
  }
  throw new Error(label + ' timed out' + (lastError ? ': ' + lastError : ''))
}

function cli(env, args) {
  const stdout = execFileSync(process.execPath, [SERVER, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return JSON.parse(stdout.trim())
}

class ServerProcess {
  constructor({ port, env }) {
    this.port = port
    this.env = env
    this.child = null
    this.stdout = []
    this.stderr = []
  }

  async start() {
    this.child = spawn(process.execPath, [SERVER, 'start'], {
      cwd: ROOT,
      env: this.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', chunk => this.stdout.push(String(chunk)))
    this.child.stderr.on('data', chunk => this.stderr.push(String(chunk)))
    try {
      await waitFor(async () => {
        const response = await fetch('http://127.0.0.1:' + this.port + '/readyz')
        const body = await response.json()
        return response.status === 200 && body.ready === true
      }, 'server ready', 25_000)
    } catch (error) {
      throw new Error(String(error) + '\nserver stdout:\n' + this.stdout.join('') + '\nserver stderr:\n' + this.stderr.join(''))
    }
    return this
  }

  async stop() {
    if (this.child === null) return
    const child = this.child
    this.child = null
    if (typeof child.exitCode === 'number') return
    child.kill('SIGTERM')
    await Promise.race([
      new Promise(resolveExit => child.once('exit', resolveExit)),
      sleep(5_000),
    ])
    if (typeof child.exitCode !== 'number') child.kill('SIGKILL')
  }
}

async function launchApp(userData) {
  const args = [ROOT, '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  if (process.platform === 'linux') args.push('--pass' + 'word-store=basic')
  const app = await electron.launch({
    args,
    cwd: ROOT,
    env: { ...process.env, QQPET_USER_DATA: userData, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    timeout: 60_000,
  })
  const page = await app.firstWindow({ timeout: 60_000 })
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => typeof window.qqpet === 'object' && window.qqpet !== null && typeof window.qqpet.storage?.status === 'function', null, { timeout: 60_000 })
  return { app, page }
}

async function main() {
  assert.equal(existsSync(SERVER), true, 'server dist is missing; run npm --prefix server run build')
  const root = mkdtempSync(join(tmpdir(), 'qqpet-cache-e2e-'))
  const userData = join(root, 'electron-user')
  const dbPath = join(root, 'qqpet.sqlite')
  const backupDir = join(root, 'backups')
  const adminSocket = join(root, 'admin.sock')
  const credentialFile = join(root, 'owner-admin-credential.txt')
  const restoreGenerationFile = join(root, 'restore-generation.txt')
  const port = await freePort()
  const serverUrl = 'ws://127.0.0.1:' + port + '/v1/sync'
  mkdirSync(userData, { recursive: true })
  mkdirSync(backupDir, { recursive: true })
  writeFileSync(credentialFile, 'cache-start-e2e-owner-admin-credential\n', { mode: 0o600 })
  const env = {
    ...process.env,
    QQPET_SYNC_DB: dbPath,
    QQPET_SYNC_BACKUP_DIR: backupDir,
    QQPET_SYNC_RESTORE_GENERATION_FILE: restoreGenerationFile,
    QQPET_ADMIN_SOCKET: adminSocket,
    QQPET_OWNER_ADMIN_CREDENTIAL: credentialFile,
    QQPET_SYNC_PORT: String(port),
    QQPET_SYNC_ADVANCE_WHILE_EMPTY: '1',
  }
  let server = null
  let app = null
  let relaunched = null
  try {
    const initialized = cli(env, ['init', '--pet-id', 'default', '--time-zone', 'Asia/Shanghai', '--weather-city', '北京'])
    assert.equal(initialized.ok, true)
    const paired = cli(env, ['pair', '--pet-id', 'default', '--role', 'owner'])
    assert.equal(paired.ok, true)
    server = await new ServerProcess({ port, env }).start()

    app = await launchApp(userData)
    const pairedStatus = await app.page.evaluate(async input => await window.qqpet.storage.pair({
      serverUrl: input.serverUrl,
      code: input.code,
      deviceLabel: 'cache-start-e2e',
    }), { serverUrl, code: paired.pairingCode })
    assert.equal(pairedStatus.paired, true)
    const mode = await app.page.evaluate(async () => await window.qqpet.storage.setMode({ mode: 'server', initialSource: 'use-server' }))
    assert.equal(mode.mode, 'server')
    assert.equal(mode.activeMode, 'server')
    await waitFor(async () => (await app.page.evaluate(async () => await window.qqpet.storage.status())).connection === 'online', 'initial online')
    const initialProjection = await app.page.evaluate(async () => await window.qqpet.getProjection())
    if (initialProjection?.shared?.havePet !== true) {
      const adopted = await app.page.evaluate(async () => await window.qqpet.command({ type: 'pet.adopt', payload: { sex: 'MM' } }, { opId: 'cache-start-adopt' }))
      assert.equal(adopted.status, 'applied')
    }
    const before = await waitFor(async () => {
      const current = await app.page.evaluate(async () => await window.qqpet.getProjection())
      return current?.shared?.havePet === true ? current : null
    }, 'initial projection with pet', 20_000)
    const beforeHash = JSON.stringify(before.shared)
    await waitFor(() => existsSync(join(userData, 'save.json')), 'projection cache file', 10_000)

    await server.stop()
    server = null
    await app.app.close()
    app = null

    const launchStarted = Date.now()
    relaunched = await launchApp(userData)
    const elapsedMs = Date.now() - launchStarted
    const status = await relaunched.page.evaluate(async () => await window.qqpet.storage.status())
    const cached = await relaunched.page.evaluate(async () => await window.qqpet.getProjection())
    assert.equal(status.readOnly, true, 'cached startup must be read-only')
    assert.notEqual(status.connection, 'online', 'cached startup must not pretend the server is online')
    assert.notEqual(cached, null, 'cached projection must be available')
    assert.equal(cached.shared.havePet, true)
    assert.equal(JSON.stringify(cached.shared), beforeHash, 'cached projection must match the last accepted projection')
    assert.equal(await relaunched.page.evaluate(() => document.getElementById('pet')?.hidden === false), true, 'pet view must be visible from cache')
    assert.ok(elapsedMs < 15_000, 'cached startup must not wait for the stopped server, elapsed=' + elapsedMs)

    const offline = await relaunched.page.evaluate(async () => await window.qqpet.command({ type: 'pet.cheer', payload: {} }, { opId: 'cache-start-offline-cheer' }))
    assert.notEqual(offline.status, 'applied', 'offline command must not be applied locally')
    assert.equal(offline.error?.code, 'offline', 'offline command error code')

    server = await new ServerProcess({ port, env }).start()
    await waitFor(async () => (await relaunched.page.evaluate(async () => await window.qqpet.storage.status())).connection === 'online', 'reconnect after server restart', 30_000)
    const recovered = await relaunched.page.evaluate(async () => await window.qqpet.command({ type: 'pet.cheer', payload: {} }, { opId: 'cache-start-online-cheer' }))
    assert.equal(recovered.status, 'applied', 'command must apply after reconnect')

    const report = {
      result: 'PASS',
      elapsedMs,
      cachedRevision: cached.revision,
      cachedEventSeq: cached.eventSeq,
      readOnly: status.readOnly,
      connection: status.connection,
      offlineCommandStatus: offline.status,
      offlineCommandCode: offline.error?.code,
      recoveredCommandStatus: recovered.status,
    }
    process.stdout.write('CACHE_START_OFFLINE_E2E ' + JSON.stringify(report) + '\n')
  } finally {
    if (relaunched !== null) await relaunched.app.close().catch(() => {})
    if (app !== null) await app.app.close().catch(() => {})
    if (server !== null) await server.stop().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
}

main().catch(error => {
  process.stderr.write('[cache-start-offline] FAILED: ' + (error instanceof Error ? error.stack ?? error.message : String(error)) + '\n')
  process.exitCode = 1
})

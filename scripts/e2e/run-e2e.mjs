/**
 * C12 real-server + two-real-Electron-process E2E.
 *
 * Starts the compiled standalone server against temporary SQLite, launches two
 * real Electron processes with distinct userData, and drives a test-only main
 * harness using the production RemoteRepository/WebSocket transport. GUI and
 * renderer rendering are intentionally out of scope; see acceptance docs.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { E2E_MIN_STEPS } from '../lib/acceptance-evidence.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const require = createRequire(import.meta.url)
const ELECTRON = require('electron')
const SERVER_ENTRY = join(ROOT, 'server/dist/server/src/index.js')
const HARNESS_ENTRY = join(ROOT, 'out/e2e/electron-harness.mjs')
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const CATCHUP_WAIT_MS = Number(process.env.QQPET_E2E_CATCHUP_WAIT_MS ?? '62000')
const CODE_REVISION = process.env.QQPET_CODE_REVISION?.trim()
  || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()

if (process.platform === 'linux' && process.env.DISPLAY === undefined && process.env.QQPET_E2E_XVFB === undefined) {
  const wrapped = spawnSync('xvfb-run', ['-a', process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, QQPET_E2E_XVFB: '1' },
  })
  if (wrapped.error === undefined) {
    process.exit(wrapped.status ?? 1)
  }
  console.error('[e2e] xvfb-run is required on headless Linux:', wrapped.error.message)
  process.exit(1)
}

const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms))

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('could not allocate a loopback port'))
        return
      }
      const port = address.port
      server.close(error => error === undefined ? resolvePort(port) : reject(error))
    })
  })
}

function parseBlob(shared, key) {
  const raw = shared?.saveJsonData?.[key]
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return {}
    }
  }
  return {}
}

function eatTaskCount(shared) {
  return Number(parseBlob(shared, 'task').doNums?.Eat ?? 0)
}

function foodCount(shared, itemId) {
  const entries = shared?.selfGoodDatas?.food
  if (Array.isArray(entries) === false) return 0
  const prefix = '_' + itemId + '*'
  for (const entry of entries) {
    if (typeof entry === 'string' && entry.startsWith(prefix)) return Number(entry.slice(prefix.length))
  }
  return 0
}

async function waitFor(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(50)
  }
  throw new Error('timed out waiting for ' + label)
}

class ElectronApp {
  constructor(options) {
    this.options = options
    this.events = []
    this.responses = new Map()
    this.nextId = 1
    this.stdout = []
    this.stderr = []
    this.child = null
    this.exited = false
    this.exitPromise = null
  }

  async launch() {
    const args = process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage', HARNESS_ENTRY] : [HARNESS_ENTRY]
    this.child = spawn(ELECTRON, args, {
      cwd: ROOT,
      env: {
        ...process.env,
        QQPET_E2E_USER_DATA: this.options.userData,
        QQPET_E2E_SERVER_URL: this.options.serverUrl,
        QQPET_E2E_PAIRING_CODE: this.options.pairingCode,
        QQPET_E2E_DEVICE_LABEL: this.options.label,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.exitPromise = new Promise(resolveExit => {
      this.child.once('exit', (code, signal) => {
        this.exited = true
        for (const pending of this.responses.values()) {
          pending.reject(new Error('Electron process exited before response'))
        }
        this.responses.clear()
        resolveExit({ code, signal })
      })
    })
    this.child.stdout.setEncoding('utf8')
    let stdoutBuffer = ''
    this.child.stdout.on('data', chunk => {
      stdoutBuffer += chunk
      while (true) {
        const lineEnd = stdoutBuffer.indexOf('\n')
        if (lineEnd < 0) break
        const line = stdoutBuffer.slice(0, lineEnd)
        stdoutBuffer = stdoutBuffer.slice(lineEnd + 1)
        this.handleLine(line)
      }
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', chunk => {
      this.stderr.push(String(chunk))
    })
    this.child.stdin.on('error', () => {})
    await this.waitForReady(20_000)
    return this
  }

  handleLine(line) {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    this.stdout.push(trimmed)
    if (trimmed.startsWith('{') === false) return
    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      return
    }
    if (typeof message.id === 'number') {
      const pending = this.responses.get(message.id)
      if (pending === undefined) return
      this.responses.delete(message.id)
      if (message.ok === true) pending.resolve(message.result)
      else pending.reject(new Error(String(message.error ?? 'harness request failed')))
      return
    }
    if (typeof message.event === 'string') this.events.push(message)
  }

  async waitForReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const failure = this.events.find(event => event.event === 'startupError')
      if (failure) throw new Error(this.options.label + ' startup failed: ' + String(failure.message))
      const boot = this.events.find(event => event.event === 'boot')
      const ready = this.events.find(event => event.event === 'ready')
      if (boot && ready) {
        assert.equal(boot.wsAvailable, true, this.options.label + ': Electron main WebSocket must be available')
        assert.equal(boot.userData, this.options.userData, this.options.label + ': userData override')
        return
      }
      await sleep(25)
    }
    throw new Error(this.options.label + ' did not become ready; stderr=' + this.stderr.join(''))
  }

  request(cmd, payload = {}, timeoutMs = 20_000) {
    if (this.exited) return Promise.reject(new Error(this.options.label + ' has exited'))
    const id = this.nextId++
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.responses.delete(id)
        reject(new Error(this.options.label + ' request timed out: ' + cmd))
      }, timeoutMs)
      this.responses.set(id, {
        resolve(value) {
          clearTimeout(timer)
          resolveRequest(value)
        },
        reject(error) {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.child.stdin.write(JSON.stringify({ id, cmd, ...payload }) + '\n')
    })
  }

  async waitEvent(predicate, label, timeoutMs = 15_000, fromIndex = 0) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = this.events.slice(fromIndex).find(predicate)
      if (found) return found
      if (this.exited) throw new Error(this.options.label + ' exited while waiting for ' + label)
      await sleep(25)
    }
    throw new Error(this.options.label + ' timed out waiting for ' + label)
  }

  mark() {
    return this.events.length
  }

  async projection() {
    return await this.request('projection', {}, 15_000)
  }

  async waitRevision(revision, timeoutMs = 15_000) {
    return await this.request('waitRevision', { revision, timeoutMs }, timeoutMs + 1_000)
  }

  async waitStatus(expected, timeoutMs = 15_000) {
    return await this.request('waitStatus', { ...expected, timeoutMs }, timeoutMs + 1_000)
  }

  async stop() {
    if (this.child === null || this.exited) return
    try {
      await this.request('quit', {}, 2_000)
    } catch {
      // The process may exit before the response is flushed.
    }
    const exited = await Promise.race([
      this.exitPromise.then(() => true),
      sleep(3_000).then(() => false),
    ])
    if (exited === false) {
      this.child.kill('SIGKILL')
      await Promise.race([this.exitPromise, sleep(2_000)])
    }
  }
}

class ServerProcess {
  constructor(options) {
    this.options = options
    this.child = null
    this.stdout = []
    this.stderr = []
    this.exitPromise = null
  }

  async start() {
    this.child = spawn(process.execPath, [SERVER_ENTRY, 'start'], {
      cwd: ROOT,
      env: this.options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', chunk => this.stdout.push(String(chunk)))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', chunk => this.stderr.push(String(chunk)))
    this.exitPromise = new Promise(resolveExit => {
      this.child.once('exit', (code, signal) => resolveExit({ code, signal }))
    })
    await this.waitHealthy(25_000)
    return this
  }

  async waitHealthy(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let lastError = ''
    while (Date.now() < deadline) {
      if (this.child && typeof this.child.exitCode === 'number') {
        throw new Error('server exited before readiness: ' + this.stderr.join(''))
      }
      try {
        const response = await fetch('http://127.0.0.1:' + this.options.port + '/readyz')
        const body = await response.json()
        if (response.status === 200 && body.ready === true) return body
        lastError = 'status ' + response.status + ' ready=' + String(body.ready)
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      await sleep(100)
    }
    throw new Error('server did not become ready: ' + lastError + '\n' + this.stderr.join(''))
  }

  async health() {
    const response = await fetch('http://127.0.0.1:' + this.options.port + '/health')
    if (response.ok === false) throw new Error('health returned ' + response.status)
    return await response.json()
  }

  async stop() {
    if (this.child === null || typeof this.child.exitCode === 'number') return
    this.child.kill('SIGTERM')
    const exited = await Promise.race([
      this.exitPromise.then(() => true),
      sleep(10_000).then(() => false),
    ])
    if (exited === false) {
      this.child.kill('SIGKILL')
      await Promise.race([this.exitPromise, sleep(2_000)])
    }
  }

  logText() {
    return this.stdout.join('') + this.stderr.join('')
  }
}

function runCli(env, args) {
  const stdout = execFileSync(process.execPath, [SERVER_ENTRY, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return JSON.parse(stdout)
}

async function waitConverged(left, right, minRevision, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  let leftProjection
  let rightProjection
  while (Date.now() < deadline) {
    leftProjection = await left.projection()
    rightProjection = await right.projection()
    if (leftProjection.revision >= minRevision
      && rightProjection.revision >= minRevision
      && leftProjection.hash === rightProjection.hash
      && leftProjection.revision === rightProjection.revision
      && leftProjection.eventSeq === rightProjection.eventSeq) {
      return { left: leftProjection, right: rightProjection }
    }
    await sleep(50)
  }
  throw new Error('clients did not converge at revision ' + minRevision
    + ': left=' + JSON.stringify(leftProjection && {
      revision: leftProjection.revision,
      eventSeq: leftProjection.eventSeq,
      hash: leftProjection.hash,
    })
    + ' right=' + JSON.stringify(rightProjection && {
      revision: rightProjection.revision,
      eventSeq: rightProjection.eventSeq,
      hash: rightProjection.hash,
    }))
}

async function main() {
  const startedAt = new Date().toISOString()
  const root = await mkdtemp(join(tmpdir(), 'qqpet-c12-e2e-'))
  const dbPath = join(root, 'qqpet.sqlite')
  const backupDir = join(root, 'backups')
  const restoreGenerationFile = join(root, 'restore-generation.txt')
  const adminSocket = join(root, 'admin.sock')
  const credentialFile = join(root, 'owner-admin-credential.txt')
  const ownerProfile = join(root, 'electron-owner')
  const playerProfile = join(root, 'electron-player')
  const port = await freePort()
  const baseEnv = {
    ...process.env,
    QQPET_SYNC_DB: dbPath,
    QQPET_SYNC_BACKUP_DIR: backupDir,
    QQPET_SYNC_RESTORE_GENERATION_FILE: restoreGenerationFile,
    QQPET_ADMIN_SOCKET: adminSocket,
    QQPET_OWNER_ADMIN_CREDENTIAL: credentialFile,
    QQPET_SYNC_BIND: '127.0.0.1',
    QQPET_SYNC_PORT: String(port),
    QQPET_SYNC_TIME_ZONE: 'Asia/Shanghai',
    QQPET_SYNC_WEATHER_LOCATION: '北京',
    QQPET_SYNC_ADVANCE_WHILE_EMPTY: '1',
    QQPET_SYNC_LOG_LEVEL: 'info',
  }
  await Promise.all([
    mkdir(ownerProfile, { recursive: true }),
    mkdir(playerProfile, { recursive: true }),
    mkdir(backupDir, { recursive: true }),
  ])
  await writeFile(credentialFile, 'c12-e2e-owner-admin-credential\n', { mode: 0o600 })

  const report = {
    schemaVersion: 1,
    startedAt,
    codeRevision: CODE_REVISION,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    electron: ELECTRON,
    steps: [],
    evidence: {},
    residualGap: [
      'The Electron harness has no BrowserWindow or renderer. It exercises the real production RemoteRepository, real WebSocket transport, real Electron main-process boundary and real standalone server, but not renderer/GUI automation.',
      'Two separate Electron OS processes with distinct QQPET_USER_DATA directories are used; full desktop shell startup, preload IPC and visual projection rendering are not covered by this automated test.',
    ],
  }
  const step = async (name, fn) => {
    const at = Date.now()
    process.stdout.write('[e2e] START ' + name + '\n')
    try {
      const detail = await fn()
      const durationMs = Date.now() - at
      report.steps.push({ name, status: 'pass', durationMs, detail })
      process.stdout.write('[e2e] PASS ' + name + ' (' + durationMs + 'ms)\n')
      return detail
    } catch (error) {
      report.steps.push({
        name,
        status: 'fail',
        durationMs: Date.now() - at,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      })
      process.stdout.write('[e2e] FAIL ' + name + ': ' + (error instanceof Error ? error.message : String(error)) + '\n')
      throw error
    }
  }

  let owner = null
  let player = null
  let server = null
  let ownerToken = ''
  let pairingOwner = ''
  let pairingPlayer = ''
  try {
    await step('compile standalone server and Electron main harness', async () => {
      execFileSync(NPM, ['--prefix', 'server', 'run', 'build'], { cwd: ROOT, env: baseEnv, stdio: 'inherit' })
      await mkdir(dirname(HARNESS_ENTRY), { recursive: true })
      await build({
        entryPoints: [join(HERE, 'electron-harness.ts')],
        outfile: HARNESS_ENTRY,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        external: ['electron'],
        logLevel: 'warning',
        sourcemap: false,
      })
      return { serverEntry: SERVER_ENTRY, harnessEntry: HARNESS_ENTRY }
    })

    await step('initialize temporary SQLite WAL server and mint real pairing codes', async () => {
      const init = runCli(baseEnv, ['init', '--db', dbPath, '--pet-id', 'default', '--time-zone', 'Asia/Shanghai', '--weather-city', '北京'])
      pairingOwner = init.pairingCode
      assert.equal(init.ok, true)
      assert.equal(init.authority.state, 'active')
      const pairPlayer = runCli(baseEnv, ['pair', '--db', dbPath, '--pet-id', 'default', '--role', 'player'])
      pairingPlayer = pairPlayer.pairingCode
      assert.match(pairingOwner, /^[A-Za-z0-9_-]{43,}$/)
      assert.match(pairingPlayer, /^[A-Za-z0-9_-]{43,}$/)
      return { dbPath, pairingExpiresAtMs: init.pairingExpiresAtMs, authorityId: init.authority.authorityId }
    })

    await step('start real standalone server and verify WAL + synchronous=FULL health', async () => {
      server = await new ServerProcess({ port, env: baseEnv }).start()
      const health = await server.health()
      assert.equal(health.journalMode, 'wal')
      assert.equal(health.synchronous, 'full')
      assert.equal(health.ready, true)
      assert.equal(health.activeClientCount, 0)
      return {
        journalMode: health.journalMode,
        synchronous: health.synchronous,
        authorityId: health.authorityId,
        revision: health.revision,
        gameTimeMs: health.gameTimeMs,
      }
    })

    await step('launch two real Electron processes with distinct userData and pair owner/player', async () => {
      const launchOwner = new ElectronApp({
        label: 'owner-electron',
        userData: ownerProfile,
        serverUrl: 'ws://127.0.0.1:' + port + '/v1/sync',
        pairingCode: pairingOwner,
      }).launch()
      const launchPlayer = new ElectronApp({
        label: 'player-electron',
        userData: playerProfile,
        serverUrl: 'ws://127.0.0.1:' + port + '/v1/sync',
        pairingCode: pairingPlayer,
      }).launch()
      const [ownerApp, playerApp] = await Promise.all([launchOwner, launchPlayer])
      owner = ownerApp
      player = playerApp
      const ownerIdentity = await owner.request('identity')
      const playerIdentity = await player.request('identity')
      assert.ok(ownerIdentity.deviceId)
      assert.ok(playerIdentity.deviceId)
      assert.notEqual(ownerIdentity.deviceId, playerIdentity.deviceId)
      assert.notEqual(ownerProfile, playerProfile)
      ownerToken = (await readFile(join(ownerProfile, 'e2e-device-token.txt'), 'utf8')).trim()
      assert.ok(ownerToken.length >= 43)
      const ownerStatus = await owner.request('status')
      const playerStatus = await player.request('status')
      assert.equal(ownerStatus.status.role, 'owner')
      assert.equal(ownerStatus.status.connection, 'online')
      assert.equal(playerStatus.status.role, 'player')
      return {
        ownerPid: owner.child.pid,
        playerPid: player.child.pid,
        ownerDeviceId: ownerIdentity.deviceId,
        playerDeviceId: playerIdentity.deviceId,
        ownerUserData: ownerProfile,
        playerUserData: playerProfile,
      }
    })

    await step('first-run adopt on empty server and two-client convergence', async () => {
      const before = await owner.projection()
      assert.equal(before.shared.havePet, false)
      const adopted = await owner.request('command', {
        opId: 'c12-adopt-owner',
        command: { type: 'pet.adopt', payload: { sex: 'GG' } },
      })
      assert.equal(adopted.status, 'applied')
      const converged = await waitConverged(owner, player, adopted.revision)
      assert.equal(converged.left.shared.havePet, true)
      assert.equal(converged.right.shared.havePet, true)
      assert.equal(converged.left.shared.petInfo.name, converged.right.shared.petInfo.name)
      return {
        revision: converged.left.revision,
        eventSeq: converged.left.eventSeq,
        hash: converged.left.hash,
        name: converged.left.shared.petInfo.name,
      }
    })

    await step('feed on instance A updates inventory/task and reaches instance B within 3s', async () => {
      const bought = await owner.request('command', {
        opId: 'c12-buy-food',
        command: { type: 'inventory.buy', payload: { type: 'food', itemId: '102010001', quantity: 2 } },
      })
      assert.equal(bought.status, 'applied')
      await waitConverged(owner, player, bought.revision)
      const beforeFeed = await player.projection()
      const beforeEat = eatTaskCount(beforeFeed.shared)
      const beforeFood = foodCount(beforeFeed.shared, '102010001')
      assert.ok(beforeFood >= 2, 'buy must place food in the projection')

      const latencyStart = Date.now()
      const fed = await owner.request('command', {
        opId: 'c12-feed-once',
        command: { type: 'inventory.use', payload: { type: 'food', itemId: '102010001', quantity: 1 } },
      })
      assert.equal(fed.status, 'applied')
      await player.waitRevision(fed.revision)
      const latencyMs = Date.now() - latencyStart
      assert.ok(latencyMs <= 3_000, 'player projection latency must be <= 3000ms, got ' + latencyMs)
      const converged = await waitConverged(owner, player, fed.revision)
      assert.equal(eatTaskCount(converged.left.shared), beforeEat + 1)
      assert.equal(eatTaskCount(converged.right.shared), beforeEat + 1)
      assert.equal(foodCount(converged.left.shared, '102010001'), beforeFood - 1)
      assert.equal(foodCount(converged.right.shared, '102010001'), beforeFood - 1)
      return {
        revision: converged.left.revision,
        eventSeq: converged.left.eventSeq,
        hash: converged.left.hash,
        eatTaskBefore: beforeEat,
        eatTaskAfter: eatTaskCount(converged.right.shared),
        foodBefore: beforeFood,
        foodAfter: foodCount(converged.right.shared, '102010001'),
        playerLatencyMs: latencyMs,
      }
    })

    await step('duplicate opId is idempotent on the real server', async () => {
      const opId = 'c12-duplicate-op'
      const command = {
        type: 'inventory.buy',
        payload: { type: 'food', itemId: '102010001', quantity: 1 },
      }
      const first = await owner.request('command', { opId, command })
      assert.equal(first.status, 'applied')
      const afterFirst = await waitConverged(owner, player, first.revision)
      const firstFood = foodCount(afterFirst.left.shared, '102010001')
      const second = await owner.request('command', { opId, command })
      assert.equal(second.status, 'duplicate')
      assert.equal(second.original, 'applied')
      assert.equal(second.revision, first.revision)
      assert.equal(second.commandSeq, first.commandSeq)
      await sleep(100)
      const afterSecond = await waitConverged(owner, player, first.revision)
      assert.equal(afterSecond.left.revision, afterFirst.left.revision)
      assert.equal(afterSecond.left.hash, afterFirst.left.hash)
      assert.equal(foodCount(afterSecond.left.shared, '102010001'), firstFood)
      return {
        opId,
        originalStatus: second.original,
        revision: second.revision,
        commandSeq: second.commandSeq,
        foodCount: firstFood,
      }
    })

    await step('lost command result reconciles via commandStatus after reconnect without resend', async () => {
      const before = await owner.projection()
      const beforeGrowth = Number(before.shared.petInfo.growth)
      const opId = 'c12-lost-result'
      const mark = owner.mark()
      await owner.request('armFault', { kind: 'commandResult' })
      const pending = owner.request('command', {
        opId,
        command: { type: 'admin.grantCheat', payload: { stat: 'growth', amount: 11 } },
      }, 30_000)
      await owner.waitEvent(
        event => event.event === 'frameDropped' && event.kind === 'commandResult',
        'dropped command result',
        10_000,
        mark,
      )
      await owner.request('forceClose')
      const reconciled = await pending
      assert.equal(reconciled.status, 'applied')
      assert.equal(reconciled.opId, opId)
      await owner.request('waitOnline', { timeoutMs: 15_000 })
      const after = await owner.projection()
      assert.equal(Number(after.shared.petInfo.growth), beforeGrowth + 11)
      const stats = await owner.request('stats')
      assert.equal(stats.stats.sentCommands.filter(entry => entry.opId === opId).length, 1)
      assert.ok(stats.stats.commandStatuses.includes(opId), 'reconnect must reconcile with commandStatus')
      return {
        opId,
        status: reconciled.status,
        revision: reconciled.revision,
        commandSeq: reconciled.commandSeq,
        growthBefore: beforeGrowth,
        growthAfter: Number(after.shared.petInfo.growth),
        commandFramesForOp: 1,
        commandStatusReconciled: true,
      }
    })

    await step('revision gap triggers resync and full snapshot convergence', async () => {
      const markPlayer = player.mark()
      await player.request('armFault', { kind: 'projection' })
      const first = await owner.request('command', {
        opId: 'c12-gap-first',
        command: { type: 'admin.grantCheat', payload: { stat: 'growth', amount: 3 } },
      })
      assert.equal(first.status, 'applied')
      await player.waitEvent(
        event => event.event === 'frameDropped' && event.kind === 'projection',
        'dropped projection',
        10_000,
        markPlayer,
      )
      const second = await owner.request('command', {
        opId: 'c12-gap-second',
        command: { type: 'admin.grantCheat', payload: { stat: 'growth', amount: 3 } },
      })
      assert.equal(second.status, 'applied')
      await player.waitEvent(event => event.event === 'resync', 'resync after revision gap', 15_000, markPlayer)
      await player.request('waitOnline', { timeoutMs: 15_000 })
      const converged = await waitConverged(owner, player, second.revision)
      const stats = await player.request('stats')
      assert.ok(stats.stats.resyncs >= 1)
      assert.ok(stats.stats.snapshotsReceived >= 1)
      return {
        droppedProjectionRevision: first.revision,
        nextCommandRevision: second.revision,
        resyncRequests: stats.stats.resyncs,
        snapshotsReceived: stats.stats.snapshotsReceived,
        convergedRevision: converged.right.revision,
        hash: converged.right.hash,
      }
    })

    await step('device revoke closes the player Electron connection and preserves owner projection', async () => {
      const playerIdentity = await player.request('identity')
      const ownerBefore = await owner.projection()
      const revoked = await owner.request('command', {
        opId: 'c12-revoke-player',
        command: { type: 'device.revoke', payload: { deviceId: playerIdentity.deviceId } },
      })
      assert.equal(revoked.status, 'applied')
      await player.waitStatus({ state: 'error', notice: 'device_revoked' }, 15_000)
      const playerStatus = await player.request('status')
      assert.equal(playerStatus.projectionPresent, false)
      assert.equal(playerStatus.hasProjectionCache, false)
      await sleep(500)
      const ownerStatus = await owner.request('status')
      assert.equal(ownerStatus.status.connection, 'online')
      assert.equal(ownerStatus.projectionPresent, true)
      assert.notEqual(ownerStatus.status.notice, 'device_revoked')
      const ownerAfter = await owner.projection()
      assert.equal(ownerAfter.hash, ownerBefore.hash)
      await waitFor(async () => (await server.health()).activeClientCount === 1, 'one remaining active owner connection')
      await player.stop()
      player = null
      return {
        revokedDeviceId: playerIdentity.deviceId,
        playerState: playerStatus.status.state,
        playerNotice: playerStatus.status.notice,
        playerProjectionPresent: playerStatus.projectionPresent,
        playerCachePresent: playerStatus.hasProjectionCache,
        ownerStillOnline: ownerStatus.status.connection,
        ownerProjectionHashUnchanged: true,
      }
    })

    let detachEpoch = 0
    let backupPath = ''
    let beforeRestart = null
    await step('authority detach and resume recover to a full authoritative snapshot', async () => {
      const beforeDetach = await owner.projection()
      const detached = await owner.request('command', {
        opId: 'c12-detach-server',
        command: { type: 'admin.exportForDetach', payload: {} },
      })
      assert.equal(detached.status, 'applied')
      assert.ok(detached.result?.bundle)
      assert.ok(detached.result?.authority)
      detachEpoch = detached.result.authority.epoch
      await owner.waitStatus({ state: 'online', authorityState: 'archived', stableMs: 600 }, 20_000)

      const bundle = structuredClone(detached.result.bundle)
      bundle.authority = {
        ...bundle.authority,
        owner: 'local',
        epoch: detachEpoch + 1,
        handoffId: 'c12-local-hop-' + Date.now(),
      }
      bundle.originLocalDeviceId = 'c12-local-device'
      const resumed = await owner.request('command', {
        opId: 'c12-resume-server',
        command: {
          type: 'admin.resumeServer',
          payload: { expectedEpoch: bundle.authority.epoch, bundle },
        },
      })
      assert.equal(resumed.status, 'applied')
      assert.equal(resumed.result.epoch, detachEpoch + 2)
      await owner.waitStatus({ state: 'online', authorityState: 'active' }, 20_000)

      const mark = owner.mark()
      await owner.request('requestResync')
      await owner.waitEvent(event => event.event === 'resync', 'post-resume full snapshot', 20_000, mark)
      const afterResume = await owner.projection()
      assert.equal(afterResume.hash, beforeDetach.hash)
      const stats = await owner.request('stats')
      assert.ok(stats.stats.snapshotsReceived >= 1)
      const health = await server.health()
      assert.equal(health.authorityState, 'active')
      return {
        archivedEpoch: detachEpoch,
        resumedEpoch: resumed.result.epoch,
        authorityState: afterResume.authority.state,
        snapshotHashPreserved: true,
        snapshotsReceived: stats.stats.snapshotsReceived,
        healthAuthorityEpoch: health.authorityEpoch,
      }
    })

    await step('create consistent online backup for later restore/authority-reset proof', async () => {
      backupPath = join(root, 'c12-pre-restart.sqlite')
      const backup = runCli(baseEnv, ['backup', '--db', dbPath, '--pet-id', 'default', '--output', backupPath])
      assert.equal(backup.ok, true)
      const bytes = await readFile(backupPath)
      assert.ok(bytes.byteLength > 0)
      beforeRestart = await owner.projection()
      const health = await server.health()
      return {
        backupPath,
        backupBytes: bytes.byteLength,
        revision: beforeRestart.revision,
        eventSeq: beforeRestart.eventSeq,
        gameTimeMs: beforeRestart.gameTimeMs,
        authorityId: health.authorityId,
        authorityEpoch: health.authorityEpoch,
        restoreGeneration: health.restoreGeneration,
      }
    })

    await step('server restart catch-up preserves state and advances game time', async () => {
      await owner.stop()
      owner = null
      const preStopHealth = await server.health()
      const preStopProjection = beforeRestart
      await server.stop()
      await sleep(CATCHUP_WAIT_MS)
      server = new ServerProcess({ port, env: baseEnv })
      await server.start()
      const caughtUpHealth = await server.health()
      assert.equal(caughtUpHealth.ready, true)
      assert.equal(caughtUpHealth.authorityId, preStopHealth.authorityId)
      assert.equal(caughtUpHealth.authorityEpoch, preStopHealth.authorityEpoch)
      assert.equal(caughtUpHealth.restoreGeneration, preStopHealth.restoreGeneration)

      owner = await new ElectronApp({
        label: 'owner-electron-restarted',
        userData: ownerProfile,
        serverUrl: 'ws://127.0.0.1:' + port + '/v1/sync',
        pairingCode: pairingOwner,
      }).launch()
      const after = await owner.projection()
      assert.equal(after.shared.havePet, preStopProjection.shared.havePet)
      assert.equal(after.shared.petInfo.name, preStopProjection.shared.petInfo.name)
      assert.equal(after.authority.authorityId, preStopProjection.authority.authorityId)
      assert.equal(after.authority.epoch, preStopProjection.authority.epoch)
      assert.equal(after.authority.restoreGeneration, preStopProjection.authority.restoreGeneration)
      assert.ok(after.gameTimeMs >= preStopProjection.gameTimeMs + 60_000,
        'catch-up must advance at least one canonical game minute')
      const healthAfterConnect = await server.health()
      assert.equal(healthAfterConnect.gameTimeMs, after.gameTimeMs)
      assert.ok(caughtUpHealth.revision >= preStopHealth.revision)
      return {
        downtimeMs: CATCHUP_WAIT_MS,
        revisionBefore: preStopProjection.revision,
        revisionAfter: after.revision,
        gameTimeBefore: preStopProjection.gameTimeMs,
        gameTimeAfter: after.gameTimeMs,
        gameTimeAdvancedMs: after.gameTimeMs - preStopProjection.gameTimeMs,
        authorityIdPreserved: true,
        name: after.shared.petInfo.name,
      }
    })

    await step('authority_reset_required after operator restore recovers to a full snapshot', async () => {
      const beforeRestore = await owner.projection()
      const preRestoreHealth = await server.health()
      await owner.stop()
      owner = null
      await server.stop()
      const restored = runCli(baseEnv, [
        'restore',
        '--db', dbPath,
        '--from', backupPath,
        '--accept-rollback',
        '--owner-admin-credential', credentialFile,
        '--restore-generation', '1',
      ])
      assert.equal(restored.ok, true)
      assert.equal(restored.restoreGeneration, 1)
      server = new ServerProcess({ port, env: baseEnv })
      await server.start()
      const resetHealth = await server.health()
      assert.equal(resetHealth.authorityState, 'active')
      assert.equal(resetHealth.restoreGeneration, 1)
      assert.notEqual(resetHealth.authorityId, preRestoreHealth.authorityId)

      owner = await new ElectronApp({
        label: 'owner-electron-after-restore',
        userData: ownerProfile,
        serverUrl: 'ws://127.0.0.1:' + port + '/v1/sync',
        pairingCode: pairingOwner,
      }).launch()
      await owner.request('waitOnline', { timeoutMs: 20_000 })
      const after = await owner.projection()
      const stats = await owner.request('stats')
      assert.equal(after.authority.state, 'active')
      assert.equal(after.authority.restoreGeneration, 1)
      assert.equal(after.authority.authorityId, resetHealth.authorityId)
      assert.equal(after.shared.havePet, beforeRestore.shared.havePet)
      assert.equal(after.shared.petInfo.name, beforeRestore.shared.petInfo.name)
      assert.ok(stats.stats.authorityResetFrames >= 1, 'client must receive authorityResetRequired')
      assert.ok(stats.stats.snapshotsReceived >= 1, 'client must recover through a full snapshot')
      const resetNotice = owner.events.some(event =>
        event.event === 'status' && event.notice === 'authority_reset_required')
      assert.equal(resetNotice, true)
      const finalHealth = await server.health()
      assert.equal(finalHealth.authorityId, after.authority.authorityId)
      assert.equal(finalHealth.restoreGeneration, after.authority.restoreGeneration)
      return {
        previousAuthorityId: preRestoreHealth.authorityId,
        previousRestoreGeneration: preRestoreHealth.restoreGeneration,
        restoredAuthorityId: after.authority.authorityId,
        restoreGeneration: after.authority.restoreGeneration,
        authorityResetFrames: stats.stats.authorityResetFrames,
        snapshotsReceived: stats.stats.snapshotsReceived,
        snapshotRevision: after.revision,
        snapshotEventSeq: after.eventSeq,
        snapshotHash: after.hash,
        recoveredName: after.shared.petInfo.name,
      }
    })

    await step('projection/log secret and device-local field hygiene', async () => {
      const projection = await owner.projection()
      const sharedJson = JSON.stringify(projection.shared)
      for (const forbidden of ['"aiKey"', '"searchKey"', '"webhookToken"', '"pairingCode"', '"tokenHash"', '"localDeviceId"']) {
        assert.equal(sharedJson.includes(forbidden), false, 'canonical projection must not contain ' + forbidden)
      }
      const ownerIdentity = await owner.request('identity')
      assert.equal(sharedJson.includes(ownerIdentity.deviceId), false, 'canonical projection must not contain device ID')
      assert.equal(sharedJson.includes(ownerToken), false, 'canonical projection must not contain device token')
      const logs = server.logText()
      assert.equal(logs.includes(ownerToken), false, 'server logs must not contain owner token')
      assert.equal(logs.includes(pairingOwner), false, 'server logs must not contain owner pairing code')
      assert.equal(logs.includes(pairingPlayer), false, 'server logs must not contain player pairing code')
      return {
        canonicalProjectionForbiddenFieldsAbsent: true,
        deviceIdAbsentFromCanonicalProjection: true,
        tokensAndPairingCodesAbsentFromServerLog: true,
      }
    })

    if (report.steps.length < E2E_MIN_STEPS) {
      throw new Error('E2E completed only ' + report.steps.length + ' steps; minimum is ' + E2E_MIN_STEPS)
    }
    if (report.steps.every(step => step.status === 'pass') === false) {
      throw new Error('E2E report contains a non-passing scenario')
    }
    report.finishedAt = new Date().toISOString()
    report.result = 'PASS'
    report.evidence.database = {
      path: dbPath,
      journalMode: 'wal',
      synchronous: 'full',
      backupPath,
      restoreGenerationFile,
    }
    report.evidence.twoProcesses = true
    report.evidence.realWebSocket = true
    report.evidence.realStandaloneServer = true
    report.evidence.guiCoverage = false
    process.stdout.write('[e2e] ALL SCENARIOS PASSED\n')
  } catch (error) {
    report.finishedAt = new Date().toISOString()
    report.result = 'FAIL'
    report.error = error instanceof Error ? error.stack ?? error.message : String(error)
    throw error
  } finally {
    if (owner) await owner.stop().catch(() => {})
    if (player) await player.stop().catch(() => {})
    if (server) {
      report.serverLog = server.logText()
      await server.stop().catch(() => {})
    }
    const artifactDir = process.env.QQPET_E2E_ARTIFACTS
    if (artifactDir) {
      await mkdir(artifactDir, { recursive: true })
      await writeFile(join(artifactDir, 'c12-e2e-report.json'), JSON.stringify(report, null, 2))
      await writeFile(join(artifactDir, 'c12-server.log'), report.serverLog ?? '')
      if (owner) {
        await writeFile(join(artifactDir, 'c12-owner-harness.log'), owner.stdout.join('\n'))
      }
    }
    if (process.env.QQPET_E2E_KEEP_TEMP === '1') {
      process.stdout.write('[e2e] temp dir kept: ' + root + '\n')
    } else {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
    process.stdout.write('C12_E2E_REPORT ' + JSON.stringify({
      result: report.result,
      steps: report.steps.map(item => ({ name: item.name, status: item.status, durationMs: item.durationMs })),
      residualGap: report.residualGap,
    }) + '\n')
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  process.stderr.write('[e2e] FAILED: ' + message + '\n')
  process.exitCode = 1
})

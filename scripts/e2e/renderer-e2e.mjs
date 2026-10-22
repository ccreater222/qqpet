/**
 * C12 real two-renderer acceptance E2E.
 *
 * Starts the compiled standalone server against temporary SQLite, launches two
 * real Electron applications with distinct QQPET_USER_DATA directories through
 * playwright-core's Electron support, and drives the production preload API
 * from inside both real BrowserWindow renderers. No main-process-only harness
 * is used for the acceptance result.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import { E2E_MIN_STEPS } from '../lib/acceptance-evidence.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const SERVER_ENTRY = join(ROOT, 'server/dist/server/src/index.js')
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const CODE_REVISION = process.env.QQPET_CODE_REVISION?.trim()
  || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()

if (process.platform === 'linux' && process.env.DISPLAY === undefined && process.env.QQPET_E2E_XVFB === undefined) {
  const wrapped = spawnSync('xvfb-run', ['-a', process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, QQPET_E2E_XVFB: '1' },
  })
  if (wrapped.error === undefined) process.exit(wrapped.status ?? 1)
  console.error('[renderer-e2e] xvfb-run is required on headless Linux:', wrapped.error.message)
  process.exit(1)
}

const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms))
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

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

function runCli(env, args) {
  const stdout = execFileSync(process.execPath, [SERVER_ENTRY, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return JSON.parse(stdout)
}

async function waitFor(predicate, label, timeoutMs = 15_000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await predicate()
      if (last) return last
    } catch (error) {
      last = error
    }
    await sleep(intervalMs)
  }
  throw new Error('timed out waiting for ' + label + (last === undefined ? '' : ': ' + String(last)))
}

function projectionHash(projection) {
  return hash(projection.shared)
}

function sameProjection(left, right) {
  return left.revision === right.revision
    && left.eventSeq === right.eventSeq
    && projectionHash(left) === projectionHash(right)
}

async function waitConverged(left, right, minRevision, timeoutMs = 15_000) {
  let leftProjection
  let rightProjection
  try {
    await waitFor(async () => {
      leftProjection = await left.projection()
      rightProjection = await right.projection()
      return leftProjection !== null
        && rightProjection !== null
        && leftProjection.revision >= minRevision
        && rightProjection.revision >= minRevision
        && sameProjection(leftProjection, rightProjection)
    }, 'renderer projections to converge at revision ' + minRevision, timeoutMs)
  } catch (error) {
    const compact = projection => projection === null ? null : {
      revision: projection.revision,
      eventSeq: projection.eventSeq,
      hash: projectionHash(projection),
    }
    throw new Error(String(error instanceof Error ? error.message : error)
      + ' left=' + JSON.stringify(compact(leftProjection))
      + ' right=' + JSON.stringify(compact(rightProjection)))
  }
  return { left: leftProjection, right: rightProjection }
}

function foodCount(projection, itemId) {
  const entries = projection.shared?.selfGoodDatas?.food
  if (Array.isArray(entries) === false) return 0
  const prefix = '_' + itemId + '*'
  for (const entry of entries) {
    if (typeof entry === 'string' && entry.startsWith(prefix)) return Number(entry.slice(prefix.length))
  }
  return 0
}

function eatTaskCount(projection) {
  const raw = projection.shared?.saveJsonData?.task
  if (typeof raw !== 'string') return 0
  try {
    return Number(JSON.parse(raw).doNums?.Eat ?? 0)
  } catch {
    return 0
  }
}

class ServerProcess {
  constructor(options) {
    this.options = options
    this.child = null
    this.stdout = []
    this.stderr = []
    this.exitPromise = null
    this.stopped = false
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
      if (this.child !== null && typeof this.child.exitCode === 'number') {
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
    if (this.stopped) return
    this.stopped = true
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
    return this.exitPromise
  }

  logText() {
    return this.stdout.join('') + this.stderr.join('')
  }
}

class RendererApp {
  constructor(options) {
    this.label = options.label
    this.userData = options.userData
    this.serverUrl = options.serverUrl
    this.app = null
    this.page = null
    this.pid = null
    this.closed = false
  }

  async launch() {
    const args = [ROOT, '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    if (process.platform === 'linux') args.push('--password-store=basic')
    this.app = await electron.launch({
      args,
      cwd: ROOT,
      env: {
        ...process.env,
        QQPET_USER_DATA: this.userData,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      },
      timeout: 60_000,
    })
    this.pid = this.app.process().pid
    assert.equal(typeof this.pid, 'number', this.label + ': Electron main pid')
    this.page = await this.app.firstWindow({ timeout: 60_000 })
    await this.page.waitForLoadState('domcontentloaded')
    await this.page.waitForFunction(
      () => typeof window.qqpet === 'object' && window.qqpet !== null
        && typeof window.qqpet.storage?.status === 'function',
      null,
      { timeout: 60_000 },
    )
    await this.installFaultControl()
    return this
  }

  /**
   * Test-only fault seam in the real Electron main process. It wraps the same
   * global WebSocket used by the production transport so the renderer can
   * observe a genuine dropped projection frame and recover through resync.
   */
  async installFaultControl() {
    await this.app.evaluate(() => {
      const OriginalWebSocket = globalThis.WebSocket
      const state = {
        dropProjection: 0,
        droppedProjections: 0,
        sentResyncs: 0,
        sentHellos: 0,
        sockets: 0,
      }
      globalThis.__QQPET_C12_WS_FAULTS__ = state
      globalThis.WebSocket = class extends OriginalWebSocket {
        constructor(url) {
          super(url)
          state.sockets += 1
          this.addEventListener('message', event => {
            if (state.dropProjection <= 0) return
            let frame
            try {
              frame = JSON.parse(event.data)
            } catch {
              return
            }
            if (frame?.t !== 'projection') return
            state.dropProjection -= 1
            state.droppedProjections += 1
            event.stopImmediatePropagation()
          }, true)
        }

        send(data) {
          try {
            const frame = JSON.parse(String(data))
            if (frame?.t === 'resync') state.sentResyncs += 1
            if (frame?.t === 'hello') state.sentHellos += 1
          } catch {
            // Non-JSON payloads are not used by this protocol.
          }
          return super.send(data)
        }
      }
    })
  }

  async storageStatus() {
    return await this.page.evaluate(async () => await window.qqpet.storage.status())
  }

  async projection() {
    return await this.page.evaluate(async () => await window.qqpet.getProjection())
  }

  async repositoryStatus() {
    return await this.page.evaluate(async () => await window.qqpet.getStatus())
  }

  async command(command, opId) {
    return await this.page.evaluate(
      async input => await window.qqpet.command(input.command, { opId: input.opId }),
      { command, opId },
    )
  }

  async pair(code, deviceLabel) {
    return await this.page.evaluate(
      async input => await window.qqpet.storage.pair({
        serverUrl: input.serverUrl,
        code: input.code,
        deviceLabel: input.deviceLabel,
      }),
      { serverUrl: this.serverUrl, code, deviceLabel },
    )
  }

  async setServerMode(initialSource = 'use-server') {
    return await this.page.evaluate(
      async source => await window.qqpet.storage.setMode({ mode: 'server', initialSource: source }),
      initialSource,
    )
  }

  async requestResync() {
    await this.page.evaluate(async () => await window.qqpet.requestResync())
  }

  async waitOnline(timeoutMs = 20_000) {
    return await waitFor(async () => {
      const status = await this.storageStatus()
      return status.connection === 'online' ? status : null
    }, this.label + ' renderer storage online', timeoutMs)
  }

  async websocketFaultState() {
    return await this.app.evaluate(() => ({ ...globalThis.__QQPET_C12_WS_FAULTS__ }))
  }

  async armProjectionDrop() {
    await this.app.evaluate(() => { globalThis.__QQPET_C12_WS_FAULTS__.dropProjection = 1 })
  }

  async mainProof() {
    return await this.app.evaluate(({ app, BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows().map(window => {
        const preferences = window.webContents.getLastWebPreferences()
        return {
          id: window.id,
          visible: window.isVisible(),
          destroyed: window.isDestroyed(),
          url: window.webContents.getURL(),
          webContentsId: window.webContents.id,
          contextIsolation: preferences.contextIsolation === true,
          sandbox: preferences.sandbox === true,
          nodeIntegration: preferences.nodeIntegration === true,
        }
      })
      return {
        appName: app.getName(),
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron,
        mainPid: process.pid,
        windows,
        rendererProcessCount: app.getAppMetrics().filter(metric => metric.type === 'Tab').length,
      }
    })
  }

  async rendererProof() {
    return await this.page.evaluate(() => ({
      title: document.title,
      readyState: document.readyState,
      url: location.href,
      petElementPresent: document.querySelector('#pet') !== null,
      qqpetApiKeys: Object.keys(window.qqpet).length,
      storageApiPresent: typeof window.qqpet.storage?.status === 'function',
      serverModeCapability: window.qqpet.capabilities?.serverMode === true,
    }))
  }

  async close() {
    if (this.closed) return
    this.closed = true
    if (this.app === null) return
    await this.app.close()
  }
}

async function main() {
  const startedAt = new Date().toISOString()
  const root = await mkdtemp(join(tmpdir(), 'qqpet-c12-renderer-e2e-'))
  const dbPath = join(root, 'qqpet.sqlite')
  const backupDir = join(root, 'backups')
  const restoreGenerationFile = join(root, 'restore-generation.txt')
  const adminSocket = join(root, 'admin.sock')
  const credentialFile = join(root, 'owner-admin-credential.txt')
  const ownerProfile = join(root, 'electron-owner')
  const playerProfile = join(root, 'electron-player')
  const port = await freePort()
  const serverUrl = 'ws://127.0.0.1:' + port + '/v1/sync'
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
    QQPET_SYNC_ADVANCE_WHILE_EMPTY: '0',
    QQPET_SYNC_LOG_LEVEL: 'warn',
  }
  const report = {
    schemaVersion: 2,
    startedAt,
    codeRevision: CODE_REVISION,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    steps: [],
    evidence: {},
    residualGap: [
      'Renderer automation drives the production contextBridge API inside real BrowserWindows; it does not perform pixel/OCR visual assertions or click through every UI pane.',
      'Linux CI runs Electron under xvfb, so GPU compositing and platform-specific window-manager behavior are not asserted.',
    ],
  }
  const step = async (name, fn) => {
    const at = Date.now()
    process.stdout.write('[renderer-e2e] START ' + name + '\n')
    try {
      const detail = await fn()
      const durationMs = Date.now() - at
      report.steps.push({ name, status: 'pass', durationMs, detail })
      process.stdout.write('[renderer-e2e] PASS ' + name + ' (' + durationMs + 'ms)\n')
      return detail
    } catch (error) {
      report.steps.push({
        name,
        status: 'fail',
        durationMs: Date.now() - at,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      })
      process.stdout.write('[renderer-e2e] FAIL ' + name + ': '
        + (error instanceof Error ? error.message : String(error)) + '\n')
      throw error
    }
  }

  let owner = null
  let player = null
  let server = null
  let ownerPairingCode = ''
  let playerPairingCode = ''
  let ownerDeviceId = ''
  let playerDeviceId = ''
  let rendererProof = null
  let teardownComplete = false

  try {
    await mkdir(ownerProfile, { recursive: true })
    await mkdir(playerProfile, { recursive: true })
    await mkdir(backupDir, { recursive: true })
    await writeFile(credentialFile, 'c12-renderer-e2e-owner-admin-credential\n', { mode: 0o600 })

    await step('compile compiled desktop app and standalone server', async () => {
      execFileSync(NPM, ['run', 'build'], { cwd: ROOT, env: baseEnv, stdio: 'inherit' })
      execFileSync(NPM, ['--prefix', 'server', 'run', 'build'], { cwd: ROOT, env: baseEnv, stdio: 'inherit' })
      const serverStat = await import('node:fs/promises').then(fs => fs.stat(SERVER_ENTRY))
      assert.ok(serverStat.size > 0, 'compiled standalone server entry must exist')
      return { desktopEntry: 'out/main/index.js', serverEntry: 'server/dist/server/src/index.js' }
    })

    await step('initialize temporary SQLite WAL database and mint owner/player pairing codes', async () => {
      const initialized = runCli(baseEnv, [
        'init', '--db', dbPath, '--pet-id', 'default', '--time-zone', 'Asia/Shanghai', '--weather-city', '北京',
      ])
      assert.equal(initialized.ok, true)
      assert.equal(initialized.authority.state, 'active')
      const pairedPlayer = runCli(baseEnv, ['pair', '--db', dbPath, '--pet-id', 'default', '--role', 'player'])
      ownerPairingCode = initialized.pairingCode
      playerPairingCode = pairedPlayer.pairingCode
      assert.match(ownerPairingCode, /^QQP-[A-Za-z0-9_-]{20,}$/)
      assert.match(playerPairingCode, /^QQP-[A-Za-z0-9_-]{20,}$/)
      assert.notEqual(ownerPairingCode, playerPairingCode)
      return {
        temporarySqlite: true,
        journalMode: 'wal',
        authorityIdHash: hash(initialized.authority.authorityId),
        duplicatePairingCodes: false,
      }
    })

    await step('start real standalone server and verify WAL/synchronous=FULL health', async () => {
      server = await new ServerProcess({ port, env: baseEnv }).start()
      const health = await server.health()
      assert.equal(health.ready, true)
      assert.equal(health.journalMode, 'wal')
      assert.equal(health.synchronous, 'full')
      assert.equal(health.activeClientCount, 0)
      report.evidence.database = { temporarySqlite: true, journalMode: health.journalMode, synchronous: health.synchronous }
      return {
        pid: server.child.pid,
        ready: health.ready,
        journalMode: health.journalMode,
        synchronous: health.synchronous,
        dbWritable: health.dbWritable,
        quickCheck: health.quickCheck,
      }
    })

    await step('launch owner Electron app with real BrowserWindow and preload renderer', async () => {
      owner = await new RendererApp({ label: 'owner-renderer', userData: ownerProfile, serverUrl }).launch()
      assert.notEqual(owner.page.url().startsWith('app://bundle/'), false, 'owner renderer URL')
      const storage = await owner.storageStatus()
      assert.equal(storage.serverModeAvailable, true)
      return {
        mainPid: owner.pid,
        rendererUrl: owner.page.url(),
        userDataIsolated: owner.userData === ownerProfile,
        storageApi: 'window.qqpet.storage',
      }
    })

    await step('launch player Electron app with distinct userData and real BrowserWindow', async () => {
      player = await new RendererApp({ label: 'player-renderer', userData: playerProfile, serverUrl }).launch()
      assert.notEqual(player.pid, owner.pid, 'two Electron main processes must be distinct')
      assert.notEqual(player.userData, owner.userData, 'two Electron userData directories must be distinct')
      const storage = await player.storageStatus()
      assert.equal(storage.serverModeAvailable, true)
      return {
        mainPid: player.pid,
        distinctMainProcesses: true,
        distinctUserData: true,
        rendererUrl: player.page.url(),
      }
    })

    await step('pair owner via real renderer window.qqpet.storage API', async () => {
      const paired = await owner.pair(ownerPairingCode, 'C12 owner renderer')
      assert.equal(paired.paired, true)
      assert.equal(paired.deviceRole, 'owner')
      assert.ok(typeof paired.deviceId === 'string' && paired.deviceId.length > 0)
      ownerDeviceId = paired.deviceId
      return {
        role: paired.deviceRole,
        paired: paired.paired,
        deviceIdHash: hash(ownerDeviceId),
        pairingInputSource: 'window.qqpet.storage.pair',
      }
    })

    await step('switch owner renderer to server mode with use-server source', async () => {
      const status = await owner.setServerMode('use-server')
      assert.equal(status.mode, 'server')
      assert.equal(status.activeMode, 'server')
      assert.equal(status.authority.owner, 'server')
      assert.equal(status.authority.state, 'active')
      assert.equal(status.paired, true)
      return {
        initialSource: 'use-server',
        requestedMode: status.mode,
        activeMode: status.activeMode,
        authorityOwner: status.authority.owner,
        authorityState: status.authority.state,
        connection: status.connection,
      }
    })

    await step('pair player via real renderer storage API and switch to server mode', async () => {
      const paired = await player.pair(playerPairingCode, 'C12 player renderer')
      assert.equal(paired.paired, true)
      assert.equal(paired.deviceRole, 'player')
      assert.ok(typeof paired.deviceId === 'string' && paired.deviceId.length > 0)
      playerDeviceId = paired.deviceId
      const status = await player.setServerMode('use-server')
      assert.equal(status.mode, 'server')
      assert.equal(status.activeMode, 'server')
      assert.equal(status.authority.owner, 'server')
      assert.equal(status.authority.state, 'active')
      assert.equal(status.paired, true)
      return {
        role: paired.deviceRole,
        initialSource: 'use-server',
        requestedMode: status.mode,
        activeMode: status.activeMode,
        deviceIdHash: hash(playerDeviceId),
        pairingAndModeSource: 'window.qqpet.storage',
      }
    })

    await step('initial two-renderer projection convergence over real WebSocket', async () => {
      const converged = await waitConverged(owner, player, 0, 20_000)
      assert.equal(converged.left.shared.havePet, false)
      assert.equal(converged.right.shared.havePet, false)
      const health = await server.health()
      assert.equal(health.activeClientCount, 2)
      return {
        revision: converged.left.revision,
        eventSeq: converged.left.eventSeq,
        projectionHash: projectionHash(converged.left),
        activeClientCount: health.activeClientCount,
        websocketUrl: serverUrl,
      }
    })

    await step('adopt pet from owner renderer and converge player renderer', async () => {
      const adopted = await owner.command({ type: 'pet.adopt', payload: { sex: 'GG' } }, 'c12-renderer-adopt')
      assert.equal(adopted.status, 'applied')
      const converged = await waitConverged(owner, player, adopted.revision)
      assert.equal(converged.left.shared.havePet, true)
      assert.equal(converged.right.shared.havePet, true)
      assert.equal(converged.left.shared.petInfo.name, converged.right.shared.petInfo.name)
      return {
        revision: converged.left.revision,
        eventSeq: converged.left.eventSeq,
        projectionHash: projectionHash(converged.left),
        adoptedName: converged.left.shared.petInfo.name,
      }
    })

    await step('buy food from owner renderer and converge player renderer', async () => {
      const bought = await owner.command(
        { type: 'inventory.buy', payload: { type: 'food', itemId: '102010001', quantity: 2 } },
        'c12-renderer-buy-food',
      )
      assert.equal(bought.status, 'applied')
      const converged = await waitConverged(owner, player, bought.revision)
      assert.ok(foodCount(converged.left, '102010001') >= 2)
      assert.equal(foodCount(converged.left, '102010001'), foodCount(converged.right, '102010001'))
      return {
        revision: converged.left.revision,
        foodCount: foodCount(converged.right, '102010001'),
        projectionHash: projectionHash(converged.left),
      }
    })

    await step('canonical feed from owner renderer reaches player renderer within 3s', async () => {
      const before = await player.projection()
      const beforeFood = foodCount(before, '102010001')
      const beforeEat = eatTaskCount(before)
      const latencyStartedAt = Date.now()
      const fed = await owner.command(
        { type: 'inventory.use', payload: { type: 'food', itemId: '102010001', quantity: 1 } },
        'c12-renderer-feed',
      )
      assert.equal(fed.status, 'applied')
      const playerAfter = await waitFor(async () => {
        const projection = await player.projection()
        if (projection === null || projection.revision < fed.revision) return null
        if (foodCount(projection, '102010001') !== beforeFood - 1) return null
        if (eatTaskCount(projection) !== beforeEat + 1) return null
        return projection
      }, 'player renderer feed projection', 3_000)
      const latencyMs = Date.now() - latencyStartedAt
      assert.ok(latencyMs <= 3_000, 'player renderer latency must be <= 3000ms, got ' + latencyMs)
      const converged = await waitConverged(owner, player, fed.revision)
      assert.equal(eatTaskCount(converged.left), beforeEat + 1)
      assert.equal(eatTaskCount(converged.right), beforeEat + 1)
      assert.equal(foodCount(converged.right, '102010001'), beforeFood - 1)
      return {
        revision: converged.left.revision,
        eventSeq: converged.left.eventSeq,
        projectionHash: projectionHash(converged.left),
        playLatencyMs: latencyMs,
        eatTaskBefore: beforeEat,
        eatTaskAfter: eatTaskCount(converged.right),
        foodBefore: beforeFood,
        foodAfter: foodCount(converged.right, '102010001'),
        playerProjectionUpdated: true,
      }
    })

    await step('duplicate opId through renderer is idempotent', async () => {
      const command = { type: 'inventory.buy', payload: { type: 'food', itemId: '102010001', quantity: 1 } }
      const first = await owner.command(command, 'c12-renderer-duplicate-op')
      assert.equal(first.status, 'applied')
      const afterFirst = await waitConverged(owner, player, first.revision)
      const foodAfterFirst = foodCount(afterFirst.left, '102010001')
      const second = await owner.command(command, 'c12-renderer-duplicate-op')
      assert.equal(second.status, 'duplicate')
      assert.equal(second.original, 'applied')
      assert.equal(second.revision, first.revision)
      assert.equal(second.commandSeq, first.commandSeq)
      await sleep(150)
      const afterSecond = await waitConverged(owner, player, first.revision)
      assert.equal(afterSecond.left.revision, afterFirst.left.revision)
      assert.equal(projectionHash(afterSecond.left), projectionHash(afterFirst.left))
      assert.equal(foodCount(afterSecond.right, '102010001'), foodAfterFirst)
      return {
        firstStatus: first.status,
        secondStatus: second.status,
        duplicateOriginal: second.original,
        revision: second.revision,
        commandSeq: second.commandSeq,
        projectionHash: projectionHash(afterSecond.left),
        foodCountUnchanged: foodAfterFirst === foodCount(afterSecond.right, '102010001'),
      }
    })

    await step('dropped projection frame triggers renderer revision-gap resync', async () => {
      await player.armProjectionDrop()
      const first = await owner.command(
        { type: 'inventory.buy', payload: { type: 'food', itemId: '102010001', quantity: 1 } },
        'c12-renderer-gap-first',
      )
      assert.equal(first.status, 'applied')
      await waitFor(async () => {
        const state = await player.websocketFaultState()
        return state.droppedProjections === 1 ? state : null
      }, 'player to drop one real projection frame', 10_000)
      const second = await owner.command(
        { type: 'inventory.buy', payload: { type: 'food', itemId: '102010001', quantity: 1 } },
        'c12-renderer-gap-second',
      )
      assert.equal(second.status, 'applied')
      const recovered = await waitFor(async () => {
        const projection = await player.projection()
        if (projection === null || projection.revision < second.revision) return null
        return projection
      }, 'player renderer revision-gap recovery', 20_000)
      const faultState = await player.websocketFaultState()
      assert.equal(faultState.droppedProjections, 1, 'exactly one projection frame must be dropped')
      assert.ok(faultState.sentResyncs >= 1, 'the renderer must request resync after the revision gap')
      const converged = await waitConverged(owner, player, second.revision, 20_000)
      assert.equal(projectionHash(converged.left), projectionHash(converged.right))
      return {
        droppedProjections: faultState.droppedProjections,
        sentResyncs: faultState.sentResyncs,
        firstCommandRevision: first.revision,
        secondCommandRevision: second.revision,
        recoveredRevision: recovered.revision,
        recoveredEventSeq: recovered.eventSeq,
        projectionHash: projectionHash(converged.right),
        resyncRecovered: true,
      }
    })

    await step('owner detach then resume restores authority and both renderer projections converge', async () => {
      const beforeDetach = await owner.projection()
      const detached = await owner.command({ type: 'admin.exportForDetach', payload: {} }, 'c12-renderer-detach')
      assert.equal(detached.status, 'applied')
      assert.ok(detached.result?.bundle, 'detach must return a portable bundle')
      assert.ok(detached.result?.authority, 'detach must return authority metadata')
      const archivedEpoch = detached.result.authority.epoch
      const detachedOwner = await waitFor(async () => {
        const status = await owner.storageStatus()
        return status.authority.state === 'archived' && status.connection === 'online' ? status : null
      }, 'owner authority archived and connection re-established', 20_000)
      assert.equal(detachedOwner.readOnly, true)
      const detachedPlayer = await waitFor(async () => {
        const status = await player.storageStatus()
        return status.authority.state === 'archived' && status.connection === 'online' ? status : null
      }, 'player authority archived and connection re-established', 20_000)
      assert.equal(detachedPlayer.readOnly, true)

      const bundle = structuredClone(detached.result.bundle)
      bundle.authority = {
        ...bundle.authority,
        owner: 'local',
        epoch: archivedEpoch + 1,
        handoffId: 'c12-renderer-local-hop-' + Date.now(),
      }
      bundle.originLocalDeviceId = 'c12-renderer-local-device'
      const resumed = await owner.command(
        { type: 'admin.resumeServer', payload: { expectedEpoch: bundle.authority.epoch, bundle } },
        'c12-renderer-resume',
      )
      assert.equal(resumed.status, 'applied')
      assert.equal(resumed.result.epoch, archivedEpoch + 2)
      await waitFor(async () => {
        const status = await owner.storageStatus()
        return status.authority.state === 'active' ? status : null
      }, 'owner authority active after resume', 20_000)
      await owner.requestResync()
      const converged = await waitConverged(owner, player, resumed.revision, 20_000)
      assert.equal(converged.left.authority.state, 'active')
      assert.equal(converged.right.authority.state, 'active')
      assert.equal(converged.left.authority.epoch, archivedEpoch + 2)
      assert.equal(projectionHash(converged.left), projectionHash(beforeDetach))
      assert.equal(projectionHash(converged.left), projectionHash(converged.right))
      await waitFor(async () => {
        const ownerStatus = await owner.storageStatus()
        const playerStatus = await player.storageStatus()
        return ownerStatus.connection === 'online' && ownerStatus.readOnly === false
          && playerStatus.connection === 'online' && playerStatus.readOnly === false
      }, 'both resumed renderers online and writable', 20_000)
      return {
        archivedEpoch,
        resumedEpoch: resumed.result.epoch,
        authorityOwner: converged.left.authority.owner,
        authorityState: converged.left.authority.state,
        ownerProjectionHashPreserved: projectionHash(beforeDetach) === projectionHash(converged.left),
        playerProjectionConverged: projectionHash(converged.left) === projectionHash(converged.right),
        convergedRevision: converged.left.revision,
        convergedEventSeq: converged.left.eventSeq,
        projectionHash: projectionHash(converged.left),
      }
    })

    await step('device revoke disconnects player renderer and forces read-only', async () => {
      const ownerBefore = await owner.projection()
      const devices = await owner.page.evaluate(
        async deviceId => await window.qqpet.storage.revokeDevice(deviceId),
        playerDeviceId,
      )
      assert.ok(Array.isArray(devices.devices))
      const revoked = await waitFor(async () => {
        const status = await player.storageStatus()
        return status.notice === 'device_revoked' ? status : null
      }, 'player renderer device_revoked notice', 20_000)
      assert.equal(revoked.connection, 'error')
      assert.equal(revoked.readOnly, true)
      const playerRepositoryStatus = await player.repositoryStatus()
      assert.equal(playerRepositoryStatus.state, 'error')
      assert.equal(playerRepositoryStatus.readOnly, true)
      assert.equal(playerRepositoryStatus.notice, 'device_revoked')
      assert.equal(await player.projection(), null)
      await waitFor(async () => (await server.health()).activeClientCount === 1, 'one remaining owner connection', 10_000)
      const ownerAfter = await owner.projection()
      const ownerStatus = await owner.storageStatus()
      assert.equal(ownerStatus.connection, 'online')
      assert.equal(ownerStatus.authority.state, 'active')
      assert.equal(projectionHash(ownerAfter), projectionHash(ownerBefore))
      return {
        revokedDeviceIdHash: hash(playerDeviceId),
        playerNotice: revoked.notice,
        playerConnection: revoked.connection,
        playerReadOnly: revoked.readOnly,
        playerProjectionPresent: false,
        playerRepositoryState: playerRepositoryStatus.state,
        ownerStillOnline: ownerStatus.connection,
        ownerAuthorityState: ownerStatus.authority.state,
        ownerProjectionHashUnchanged: true,
        activeClientCount: (await server.health()).activeClientCount,
      }
    })

    await step('real BrowserWindow/preload/renderer proof and evidence hygiene', async () => {
      const ownerMain = await owner.mainProof()
      const playerMain = await player.mainProof()
      const ownerRenderer = await owner.rendererProof()
      const playerRenderer = await player.rendererProof()
      const allWindows = [...ownerMain.windows, ...playerMain.windows]
      assert.ok(allWindows.length >= 2, 'two real BrowserWindows must be open')
      assert.ok(allWindows.every(window => window.destroyed === false), 'BrowserWindows must be live')
      assert.ok(allWindows.every(window => window.url.startsWith('app://bundle/')), 'BrowserWindow renderer URLs')
      assert.ok(allWindows.every(window => window.contextIsolation === true), 'contextIsolation must be enabled')
      assert.ok(allWindows.every(window => window.sandbox === true), 'sandboxed preload must be enabled')
      assert.ok(allWindows.every(window => window.nodeIntegration === false), 'nodeIntegration must stay disabled')
      assert.ok(ownerMain.rendererProcessCount >= 1 && playerMain.rendererProcessCount >= 1, 'real renderer processes')
      assert.notEqual(ownerMain.mainPid, playerMain.mainPid, 'distinct Electron main processes')
      for (const renderer of [ownerRenderer, playerRenderer]) {
        assert.equal(renderer.readyState, 'complete')
        assert.equal(renderer.title, 'QQ宠物')
        assert.equal(renderer.petElementPresent, true)
        assert.ok(renderer.qqpetApiKeys >= 40, 'preload contextBridge API must be exposed')
        assert.equal(renderer.storageApiPresent, true)
        assert.equal(renderer.serverModeCapability, true)
      }
      const reportSoFar = JSON.stringify(report)
      assert.equal(reportSoFar.includes(ownerPairingCode), false, 'owner pairing code must not enter evidence')
      assert.equal(reportSoFar.includes(playerPairingCode), false, 'player pairing code must not enter evidence')
      assert.equal(reportSoFar.includes(ownerDeviceId), false, 'raw owner device id must not enter evidence')
      assert.equal(reportSoFar.includes(playerDeviceId), false, 'raw player device id must not enter evidence')
      assert.equal(reportSoFar.includes('issuedToken'), false, 'issued tokens must not enter evidence')
      rendererProof = {
        electronMainPidsDistinct: ownerMain.mainPid !== playerMain.mainPid,
        browserWindowCount: allWindows.length,
        rendererProcessCount: ownerMain.rendererProcessCount + playerMain.rendererProcessCount,
        preloadApiExposed: ownerRenderer.qqpetApiKeys >= 40 && playerRenderer.qqpetApiKeys >= 40,
        contextIsolation: allWindows.every(window => window.contextIsolation),
        sandboxedPreload: allWindows.every(window => window.sandbox),
        nodeIntegrationDisabled: allWindows.every(window => window.nodeIntegration === false),
        rendererDocumentLoaded: ownerRenderer.readyState === 'complete' && playerRenderer.readyState === 'complete',
        guiElementPresent: ownerRenderer.petElementPresent && playerRenderer.petElementPresent,
        urls: [...new Set(allWindows.map(window => window.url))],
        titles: [...new Set([ownerRenderer.title, playerRenderer.title])],
        electronVersion: ownerMain.electronVersion,
      }
      return {
        ...rendererProof,
        evidenceHygiene: {
          pairingCodesAbsent: true,
          rawDeviceIdsAbsent: true,
          tokensAbsent: true,
        },
      }
    })

    await step('clean teardown of both Electron apps and standalone server', async () => {
      await owner.close()
      await player.close()
      await server.stop()
      teardownComplete = true
      report.evidence.teardown = true
      return {
        ownerExited: true,
        playerExited: true,
        serverExited: true,
      }
    })

    if (report.steps.length < E2E_MIN_STEPS) {
      throw new Error('renderer E2E completed only ' + report.steps.length + ' steps; minimum is ' + E2E_MIN_STEPS)
    }
    assert.ok(rendererProof !== null, 'renderer proof must be captured')
    const distinctMainPids = owner.pid !== player.pid
    const realRenderer = rendererProof.browserWindowCount >= 2
      && rendererProof.rendererProcessCount >= 2
      && rendererProof.preloadApiExposed === true
      && rendererProof.contextIsolation === true
      && rendererProof.sandboxedPreload === true
      && rendererProof.rendererDocumentLoaded === true
    const realElectron = distinctMainPids
      && rendererProof.electronMainPidsDistinct === true
      && rendererProof.browserWindowCount >= 2
      && typeof rendererProof.electronVersion === 'string'
      && rendererProof.electronVersion.length > 0
    const realStandaloneServer = typeof server.child.pid === 'number' && report.evidence.database?.journalMode === 'wal'
    const websocketEvidence = { serverUrl, activeClientCountAtConvergence: 2 }
    const realWebSocket = /^wss?:\/\//.test(websocketEvidence.serverUrl)
      && websocketEvidence.activeClientCountAtConvergence >= 2
    const rendererCoverage = distinctMainPids && realElectron && realRenderer
    const guiCoverage = realRenderer && rendererProof.guiElementPresent === true
    assert.equal(realElectron, true, 'real Electron two-process proof')
    assert.equal(realStandaloneServer, true, 'real standalone server proof')
    assert.equal(realWebSocket, true, 'real WebSocket proof')
    assert.equal(rendererCoverage, true, 'real renderer coverage proof')
    assert.equal(guiCoverage, true, 'real GUI coverage proof')
    report.evidence.twoProcesses = distinctMainPids
    report.evidence.realStandaloneServer = realStandaloneServer
    report.evidence.realWebSocket = realWebSocket
    report.evidence.realElectron = realElectron
    report.evidence.realRenderer = realRenderer
    report.evidence.rendererCoverage = rendererCoverage
    report.evidence.guiCoverage = guiCoverage
    report.evidence.ownerPid = owner.pid
    report.evidence.playerPid = player.pid
    report.evidence.rendererProof = rendererProof
    report.evidence.websocket = websocketEvidence
    report.evidence.scenarios = {
      ownerPairViaRendererStorage: true,
      playerPairAndServerModeViaRendererStorage: true,
      canonicalCommandCrossRenderer: true,
      duplicateOpId: true,
      revisionGapResyncRecovered: true,
      ownerDetachResumeRecovered: true,
      deviceRevokeDisconnectedPlayer: true,
    }
    report.evidence.hygiene = {
      pairingCodesAbsent: true,
      rawDeviceIdsAbsent: true,
      tokensAbsent: true,
    }
    report.evidence.stepCount = report.steps.length
    report.finishedAt = new Date().toISOString()
    report.result = 'PASS'
    process.stdout.write('[renderer-e2e] ALL RENDERER SCENARIOS PASSED\n')
  } catch (error) {
    report.result = 'FAIL'
    report.error = error instanceof Error ? error.stack ?? error.message : String(error)
    process.stdout.write('[renderer-e2e] FAILED: ' + (error instanceof Error ? error.message : String(error)) + '\n')
    process.exitCode = 1
  } finally {
    if (owner !== null) await owner.close().catch(() => {})
    if (player !== null) await player.close().catch(() => {})
    if (server !== null) {
      await server.stop().catch(() => {})
      if (teardownComplete === false) report.evidence.teardown = false
    }
    if (report.finishedAt === undefined) report.finishedAt = new Date().toISOString()
    report.evidence.stepCount = report.steps.length
    const artifactDir = process.env.QQPET_E2E_ARTIFACTS?.trim()
      || join(ROOT, 'docs/superpowers/acceptance/artifacts/c12-e2e')
    await mkdir(artifactDir, { recursive: true })
    const reportPath = join(artifactDir, 'c12-e2e-report.json')
    await writeFile(reportPath, JSON.stringify(report, null, 2))
    if (process.env.QQPET_E2E_KEEP_TEMP === '1') {
      process.stdout.write('[renderer-e2e] temp dir kept: ' + root + '\n')
    } else {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
    process.stdout.write('C12_RENDERER_E2E_REPORT ' + JSON.stringify({
      result: report.result,
      reportPath,
      steps: report.steps.map(item => ({ name: item.name, status: item.status, durationMs: item.durationMs })),
      evidence: report.evidence,
    }) + '\n')
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  process.stderr.write('[renderer-e2e] FAILED TO RUN: ' + message + '\n')
  process.exitCode = 1
})

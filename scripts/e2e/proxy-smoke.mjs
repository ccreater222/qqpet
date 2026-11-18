/**
 * Local TLS/WSS reverse-proxy smoke.
 *
 * Runs the production server image behind the checked-in Nginx example with a
 * self-signed certificate, then proves HTTPS health routes and authenticated
 * WebSocket upgrades for both /v1/sync and its /sync alias.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'
import { validatePublicHealthResponse } from './proxy-health-contract.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const requireFromServer = createRequire(join(ROOT, 'server/package.json'))
const WebSocket = requireFromServer('ws')
const DOCKER = process.env.DOCKER ?? 'docker'
const STARTED_AT_MS = Date.now()
const STARTED_AT = new Date(STARTED_AT_MS).toISOString()
const REPORT_PATH = process.env.QQPET_PROXY_REPORT
  ?? join(ROOT, 'docs/superpowers/acceptance/artifacts/c12-proxy/proxy-smoke-report.json')
const CODE_REVISION = process.env.QQPET_CODE_REVISION?.trim() || gitRevision()
const IMAGE = process.env.QQPET_SERVER_IMAGE?.trim()
  || 'qqpet-server:proxy-smoke-' + process.pid + '-' + STARTED_AT_MS
const NGINX_IMAGE = process.env.QQPET_PROXY_NGINX_IMAGE?.trim() || 'nginx:1.27-alpine'
const KEEP_IMAGE = process.env.QQPET_KEEP_SMOKE_IMAGE === '1'
const SUFFIX = process.pid + '-' + STARTED_AT_MS
const NETWORK = 'qqpet-proxy-smoke-' + SUFFIX
const VOLUME = 'qqpet-proxy-smoke-' + SUFFIX
const SERVER_CONTAINER = 'qqpet-proxy-server-' + SUFFIX
const PROXY_CONTAINER = 'qqpet-proxy-nginx-' + SUFFIX
const DB_PATH = '/var/lib/qqpet-sync/qqpet.sqlite'
const RESTORE_GENERATION_PATH = '/var/lib/qqpet-sync/restore-generation.txt'
const MAX_OUTPUT_CHARS = 12_000

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

function indent(text, spaces) {
  const prefix = ' '.repeat(spaces)
  return text.split('\n').map(line => line.length === 0 ? line : prefix + line).join('\n')
}

async function waitForServerReady(containerId) {
  const deadline = Date.now() + 40_000
  let lastError = ''
  const script = "fetch('http://127.0.0.1:8787/readyz').then(async response => { const body = await response.json(); console.log(JSON.stringify({ status: response.status, body })); process.exit(response.ok ? 0 : 1) }).catch(() => process.exit(1))"
  while (Date.now() < deadline) {
    try {
      const result = await run(DOCKER, ['exec', containerId, 'node', '-e', script])
      const parsed = parseJsonOutput(result.stdout)
      if (parsed.status === 200 && parsed.body.ready === true) return parsed.body
      lastError = 'status ' + String(parsed.status)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(200)
  }
  throw new Error('upstream container did not become ready: ' + lastError)
}

function httpsGet(port, path) {
  return new Promise((resolveGet, reject) => {
    const request = https.get({
      host: '127.0.0.1',
      port,
      path,
      rejectUnauthorized: false,
      servername: 'pet.example.com',
      headers: { Host: 'pet.example.com' },
      timeout: 8_000,
    }, response => {
      const tlsProtocol = response.socket?.getProtocol() ?? 'unknown'
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => {
        let parsed = null
        try {
          parsed = JSON.parse(body)
        } catch {
          parsed = null
        }
        resolveGet({
          status: response.statusCode ?? 0,
          body,
          json: parsed,
          tlsProtocol,
        })
      })
    })
    request.once('timeout', () => request.destroy(new Error('HTTPS request timed out')))
    request.once('error', reject)
  })
}

async function waitForProxy(port) {
  const deadline = Date.now() + 40_000
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      const response = await httpsGet(port, '/healthz')
      if (response.status === 200 && response.json?.ok === true) return response
      lastError = 'status ' + String(response.status) + ' body=' + tail(response.body, 500)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(250)
  }
  throw new Error('Nginx proxy did not answer /healthz: ' + lastError)
}

function authenticateOverWss(port, path, auth, label) {
  return new Promise((resolveAuth, reject) => {
    const socket = new WebSocket('wss://127.0.0.1:' + port + path, {
      rejectUnauthorized: false,
      servername: 'pet.example.com',
      headers: { Host: 'pet.example.com' },
      handshakeTimeout: 10_000,
    })
    let settled = false
    let welcome = null
    let ready = null
    const frames = []
    const timer = setTimeout(() => fail(new Error(label + ': WebSocket authentication timed out')), 15_000)
    function fail(error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.terminate()
      } catch {
        // Cleanup failure must not mask the original proxy error.
      }
      reject(error)
    }
    socket.on('open', () => {
      socket.send(JSON.stringify({
        t: 'hello',
        v: 1,
        requestId: label,
        petId: 'default',
        appVersion: '0.1.0',
        auth,
      }))
    })
    socket.on('message', data => {
      let frame
      try {
        frame = JSON.parse(String(data))
      } catch {
        fail(new Error(label + ': non-JSON WebSocket frame'))
        return
      }
      frames.push(String(frame.t))
      if (frame.t === 'welcome') welcome = frame
      if (frame.t === 'error') {
        fail(new Error(label + ': server error ' + JSON.stringify(frame)))
        return
      }
      if (frame.t === 'ready') {
        ready = frame
        if (welcome === null) {
          fail(new Error(label + ': ready arrived before welcome'))
          return
        }
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolveAuth({
          path,
          welcome,
          ready,
          frames,
          close() {
            socket.close(1000, 'proxy smoke complete')
          },
        })
      }
    })
    socket.on('unexpected-response', (_request, response) => {
      fail(new Error(label + ': WebSocket upgrade was rejected with HTTP ' + String(response.statusCode)))
    })
    socket.on('error', error => fail(new Error(label + ': ' + error.message)))
    socket.on('close', code => {
      if (settled) return
      fail(new Error(label + ': socket closed before ready (code ' + String(code) + ')'))
    })
  })
}

async function startServerContainer() {
  const result = await run(DOCKER, [
    'run', '-d', '--name', SERVER_CONTAINER,
    '--network', NETWORK,
    '--read-only',
    '--security-opt', 'no-new-privileges:true',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
    '-v', VOLUME + ':/var/lib/qqpet-sync',
    '-e', 'QQPET_SYNC_DB=' + DB_PATH,
    '-e', 'QQPET_SYNC_BACKUP_DIR=/var/lib/qqpet-sync/backups',
    '-e', 'QQPET_SYNC_RESTORE_GENERATION_FILE=' + RESTORE_GENERATION_PATH,
    '-e', 'QQPET_SYNC_TIME_ZONE=UTC',
    '-e', 'QQPET_SYNC_WEATHER_LOCATION=Proxy Smoke',
    '-e', 'QQPET_SYNC_ADVANCE_WHILE_EMPTY=0',
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
    serverImage: IMAGE,
    nginxImage: NGINX_IMAGE,
    evidence: {
      tlsTerminated: false,
      nginxProxy: false,
      webSocketUpgrade: false,
      authenticatedOverWss: false,
      syncAliasUpgrade: false,
      syncAliasAuthenticated: false,
      healthRoute: false,
      healthzRoute: false,
      readyzRoute: false,
      v1SyncRoute: false,
      syncRoute: false,
    },
  }
  let builtImage = false
  let networkCreated = false
  let volumeCreated = false
  let serverContainerId = ''
  let proxyContainerId = ''
  let tempDir = ''
  let cleanupErrors = []
  try {
    if (CODE_REVISION.length === 0) throw new Error('could not resolve current git revision')
    await mkdir(join(ROOT, 'out'), { recursive: true })
    tempDir = await mkdtemp(join(ROOT, 'out/proxy-smoke-'))
    const certPath = join(tempDir, 'server.crt')
    const keyPath = join(tempDir, 'server.key')
    const nginxConfigPath = join(tempDir, 'nginx.conf')
    await run('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', keyPath, '-out', certPath,
      '-subj', '/CN=pet.example.com',
      '-addext', 'subjectAltName=DNS:pet.example.com,IP:127.0.0.1',
    ])

    if (process.env.QQPET_SERVER_IMAGE?.trim()) {
      report.evidence.imageBuilt = true
    } else {
      process.stdout.write('[proxy-smoke] building ' + IMAGE + '\n')
      await run(DOCKER, ['build', '-f', 'server/Dockerfile', '-t', IMAGE, '.'])
      builtImage = true
      report.evidence.imageBuilt = true
    }
    await run(DOCKER, ['network', 'create', NETWORK])
    networkCreated = true
    await run(DOCKER, ['volume', 'create', VOLUME])
    volumeCreated = true
    const init = await run(DOCKER, [
      'run', '--rm', '--name', SERVER_CONTAINER + '-init',
      '-v', VOLUME + ':/var/lib/qqpet-sync',
      '-e', 'QQPET_SYNC_ADVANCE_WHILE_EMPTY=0',
      '--entrypoint', 'node', IMAGE,
      'dist/server/src/index.js', 'init',
      '--db', DB_PATH, '--pet-id', 'default', '--time-zone', 'UTC', '--weather-city', 'Proxy Smoke',
    ])
    const initialized = parseJsonOutput(init.stdout)
    if (initialized.ok === true) {
      report.evidence.initializedPetId = String(initialized.petId)
    } else {
      throw new Error('init did not return ok:true')
    }
    const pairingCode = String(initialized.pairingCode ?? '')
    if (pairingCode.length === 0) throw new Error('init did not return an owner pairing code')

    serverContainerId = await startServerContainer()
    report.evidence.containerStarted = true
    const upstreamHealth = await waitForServerReady(serverContainerId)
    const upstreamHealthContract = validatePublicHealthResponse(200, upstreamHealth)
    report.evidence.upstreamPublicHealthSchema = upstreamHealthContract.ok
    if (upstreamHealthContract.ok === false) {
      throw new Error('/readyz returned an invalid redacted public health body: '
        + upstreamHealthContract.errors.join('; '))
    }
    process.stdout.write('[proxy-smoke] upstream server ready behind private Docker network\n')

    const nginxExample = await readFile(join(ROOT, 'server/deploy/nginx.conf.example'), 'utf8')
    let rendered = nginxExample
      .replaceAll('/etc/letsencrypt/live/pet.example.com/fullchain.pem', '/etc/nginx/certs/server.crt')
      .replaceAll('/etc/letsencrypt/live/pet.example.com/privkey.pem', '/etc/nginx/certs/server.key')
      .replace('server 127.0.0.1:8787;', 'server ' + SERVER_CONTAINER + ':8787;')
      .replace('listen 443 ssl http2;', 'listen 443 ssl;')
    if (rendered.includes('/etc/letsencrypt/') || rendered.includes('127.0.0.1:8787')) {
      throw new Error('failed to render the checked-in Nginx example for the smoke topology')
    }
    const wrapped = [
      'worker_processes 1;',
      'pid /tmp/nginx.pid;',
      'error_log /dev/stderr notice;',
      'events { worker_connections 64; }',
      'http {',
      '  access_log /dev/stdout;',
      '  include /etc/nginx/mime.types;',
      indent(rendered, 2),
      '}',
      '',
    ].join('\n')
    await writeFile(nginxConfigPath, wrapped)

    const proxyPort = await freePort()
    const proxy = await run(DOCKER, [
      'run', '-d', '--name', PROXY_CONTAINER,
      '--network', NETWORK,
      '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
      '--tmpfs', '/var/cache/nginx:rw,noexec,nosuid,size=32m',
      '--tmpfs', '/var/run:rw,noexec,nosuid,size=8m',
      '-p', '127.0.0.1:' + proxyPort + ':443',
      '-v', nginxConfigPath + ':/etc/nginx/nginx.conf:ro',
      '-v', certPath + ':/etc/nginx/certs/server.crt:ro',
      '-v', keyPath + ':/etc/nginx/certs/server.key:ro',
      NGINX_IMAGE,
    ])
    proxyContainerId = proxy.stdout.trim()
    const healthz = await waitForProxy(proxyPort)
    report.evidence.nginxProxy = true
    report.evidence.tlsTerminated = String(healthz.tlsProtocol ?? '').startsWith('TLSv1')
    report.evidence.healthzRoute = healthz.status === 200 && healthz.json?.ok === true
    report.evidence.tlsProtocol = String(healthz.tlsProtocol ?? 'unknown')

    const health = await httpsGet(proxyPort, '/health')
    const healthContract = validatePublicHealthResponse(health.status, health.json)
    report.evidence.healthRoute = healthContract.ok
    const ready = await httpsGet(proxyPort, '/readyz')
    report.evidence.readyzRoute = ready.status === 200 && ready.json?.ready === true
    if (report.evidence.healthzRoute === false) throw new Error('/healthz did not pass through Nginx')
    if (report.evidence.healthRoute === false) {
      throw new Error('/health alias did not pass through Nginx with the redacted public health schema: '
        + healthContract.errors.join('; '))
    }
    if (report.evidence.readyzRoute === false) throw new Error('/readyz did not pass through Nginx')
    process.stdout.write('[proxy-smoke] HTTPS routes passed through Nginx\n')

    const canonical = await authenticateOverWss(proxyPort, '/v1/sync', {
      kind: 'pairing',
      code: pairingCode,
      deviceLabel: 'proxy-smoke-v1-sync',
    }, 'v1-sync')
    if (canonical.welcome.deviceRole !== 'owner') throw new Error('/v1/sync did not authenticate the owner')
    if (typeof canonical.welcome.issuedToken !== 'string' || canonical.welcome.issuedToken.length === 0) {
      throw new Error('/v1/sync welcome did not issue a device token')
    }
    report.evidence.v1SyncRoute = true
    report.evidence.webSocketUpgrade = true
    report.evidence.authenticatedOverWss = true
    canonical.close()

    const alias = await authenticateOverWss(proxyPort, '/sync', {
      kind: 'token',
      token: canonical.welcome.issuedToken,
    }, 'sync-alias')
    report.evidence.syncRoute = true
    report.evidence.syncAliasUpgrade = true
    report.evidence.syncAliasAuthenticated = true
    report.evidence.syncAliasDeviceIdHash = hashIdentifier(alias.welcome.deviceId)
    alias.close()
    process.stdout.write('[proxy-smoke] authenticated WSS upgrades passed for /v1/sync and /sync\n')
    report.result = 'PASS'
  } catch (error) {
    report.result = 'FAIL'
    report.error = error instanceof Error ? error.stack ?? error.message : String(error)
    process.stderr.write('[proxy-smoke] FAILED: ' + report.error + '\n')
    process.exitCode = 1
  } finally {
    if (proxyContainerId.length > 0) {
      const logs = await bestEffort(DOCKER, ['logs', '--tail', '80', proxyContainerId])
      if (logs) report.proxyLogTail = tail(logs, 6000)
      const error = await bestEffort(DOCKER, ['rm', '-f', proxyContainerId])
      if (error) cleanupErrors.push(error)
      proxyContainerId = ''
    }
    if (serverContainerId.length > 0) {
      const logs = await bestEffort(DOCKER, ['logs', '--tail', '80', serverContainerId])
      if (logs) report.serverLogTail = tail(logs, 6000)
      const error = await bestEffort(DOCKER, ['rm', '-f', serverContainerId])
      if (error) cleanupErrors.push(error)
      serverContainerId = ''
    }
    if (networkCreated) {
      const error = await bestEffort(DOCKER, ['network', 'rm', NETWORK])
      if (error) cleanupErrors.push(error)
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
    process.stdout.write('C12_PROXY_SMOKE_RESULT ' + JSON.stringify({
      result: report.result,
      report: REPORT_PATH,
      revision: report.codeRevision,
    }) + '\n')
  }
}

main().catch(error => {
  process.stderr.write('[proxy-smoke] FAILED TO RUN: ' + (error instanceof Error ? error.stack ?? error.message : String(error)) + '\n')
  process.exitCode = 1
})

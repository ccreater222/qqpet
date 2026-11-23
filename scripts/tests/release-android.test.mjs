import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  PACKAGE_NAME,
  main,
  parseArgs,
  parseEnvFile,
  resolveReleaseEnv,
  runReleaseAndroid,
  usage,
} from '../lib/release-android.mjs'

// All credentials below are obvious fixtures. No real secret is read or written.
const VERSION = '0.20.0'
const SECRET = 'fixture-password-not-real'
const DN = 'CN=QQPet Fixture, O=QQPet Test'
const CERT_SHA256 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0'
const APK_BYTES = 'fixture-apk-payload'

/* ------------------------------------------------------------------ *
 * Fixture: a disposable repo + SDK + JDK, never the real checkout.
 * ------------------------------------------------------------------ */

function fixture(t, options = {}) {
  const base = mkdtempSync(join(tmpdir(), 'qqpet-release-test-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'repo')
  const home = join(base, 'home')
  mkdirSync(join(root, 'android', 'app'), { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: options.version ?? VERSION }))
  const gradlew = join(root, 'android', 'gradlew')
  writeFileSync(gradlew, '#!/bin/sh\nexit 0\n')
  chmodSync(gradlew, options.gradleExecutable === false ? 0o644 : 0o755)
  if (options.keystoreProperties) {
    writeFileSync(join(root, 'android', 'keystore.properties'), 'storeFile=fixture.jks\n')
  }
  const javaHome = join(base, 'jdk17')
  mkdirSync(join(javaHome, 'bin'), { recursive: true })
  writeFileSync(join(javaHome, 'bin', 'java'), '')
  const sdk = join(base, 'sdk')
  const buildTools = join(sdk, 'build-tools', '35.0.0')
  mkdirSync(buildTools, { recursive: true })
  mkdirSync(join(sdk, 'platform-tools'), { recursive: true })
  if (options.apksigner !== false) writeFileSync(join(buildTools, 'apksigner'), '')
  if (options.aapt2 !== false) writeFileSync(join(buildTools, 'aapt2'), '')
  const keystore = join(base, 'release.jks')
  if (options.keystore !== false) writeFileSync(keystore, 'fixture-keystore')
  const fx = {
    base,
    root,
    home,
    javaHome,
    sdk,
    buildTools,
    keystore,
    gradlew,
    apk: join(root, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
    version: options.version ?? VERSION,
  }
  fx.env = baseEnv(fx, options.env)
  return fx
}

function baseEnv(fx, overrides = {}) {
  const env = {
    PATH: join(fx.javaHome, 'bin'),
    JAVA_HOME: fx.javaHome,
    ANDROID_HOME: fx.sdk,
    ANDROID_SDK_ROOT: fx.sdk,
    ANDROID_KEYSTORE: fx.keystore,
    ANDROID_KEYSTORE_PASSWORD: SECRET,
    ANDROID_KEY_ALIAS: 'fixture-alias',
    ANDROID_KEY_PASSWORD: SECRET,
    ...overrides,
  }
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key]
  return env
}

function handler(match, result) {
  return { match, result }
}

const isNpm = (script) => (command, args) => command === 'npm' && args[0] === 'run' && args[1] === script
const npmCall = (script) => (call) => isNpm(script)(call.command, call.args)

function fakeJava(home) {
  const version = home.includes('jdk11') ? '11.0.16.1' : '17.0.2'
  return {
    status: 0,
    stdout: '',
    stderr: `openjdk version "${version}" 2022-01-18\nOpenJDK Runtime Environment\n    java.home = ${home}\n`,
  }
}

function makeRunner(fx, handlers = []) {
  const calls = []
  const run = (command, args, options = {}) => {
    calls.push({ command, args, options })
    for (const item of handlers) {
      if (!item.match(command, args, options)) continue
      const result = typeof item.result === 'function' ? item.result(command, args, options) : item.result
      if (result) return result
    }
    if (/[\\/]bin[\\/]java$/.test(command)) return fakeJava(dirname(dirname(command)))
    if (command === join(fx.buildTools, 'apksigner')) {
      return {
        status: 0,
        stdout: `Signer #1 certificate DN: ${DN}\nSigner #1 certificate SHA-256 digest: ${CERT_SHA256}\n`,
        stderr: '',
      }
    }
    if (command === join(fx.buildTools, 'aapt2')) {
      return {
        status: 0,
        stdout: `package: name='${PACKAGE_NAME}' versionCode='102000' versionName='${fx.version}' compileSdkVersion='35'\n`,
        stderr: '',
      }
    }
    if (command === 'npm' && ['typecheck', 'build:android-web'].includes(args[1])) {
      return { status: 0, stdout: '', stderr: '' }
    }
    if (command === './gradlew' && args[0] === 'assembleRelease') {
      mkdirSync(dirname(fx.apk), { recursive: true })
      writeFileSync(fx.apk, APK_BYTES)
      return { status: 0, stdout: '', stderr: '' }
    }
    throw new Error(`unexpected command in test: ${command} ${args.join(' ')}`)
  }
  return { calls, run }
}

function context(fx, handlers = [], overrides = {}) {
  const { calls, run } = makeRunner(fx, handlers)
  const logs = []
  const prints = []
  const deps = {
    root: fx.root,
    env: fx.env,
    platform: 'linux',
    homedir: fx.home,
    run,
    log: (line) => logs.push(String(line)),
    print: (line) => prints.push(String(line)),
    ...overrides,
  }
  return { deps, calls, logs, prints }
}

const buildCalls = (calls) =>
  calls.filter((call) => call.command === 'npm' || call.command === './gradlew')

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const distPath = (fx, version = VERSION) => join(fx.root, 'dist', `QQPet-${version}.apk`)

/* ------------------------------------------------------------------ *
 * Arguments, usage, env files
 * ------------------------------------------------------------------ */

test('parseArgs accepts the documented flags and defaults', () => {
  const defaults = parseArgs([])
  assert.equal(defaults.json, false)
  assert.equal(defaults.help, false)
  assert.equal(defaults.noEnvFile, false)
  assert.equal(defaults.envFile, null)
  assert.equal(parseArgs(['--json']).json, true)
  assert.equal(parseArgs(['--env-file', '/tmp/release.env']).envFile, '/tmp/release.env')
  assert.equal(parseArgs(['--env-file=/tmp/release.env']).envFile, '/tmp/release.env')
  assert.equal(parseArgs(['--no-env-file']).noEnvFile, true)
  assert.equal(parseArgs(['--help']).help, true)
})

test('parseArgs rejects unknown, valueless and conflicting options', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown argument.*--bogus/i)
  assert.throws(() => parseArgs(['--env-file']), /missing value/i)
  assert.throws(() => parseArgs(['--env-file', '--json']), /missing value/i)
  assert.throws(() => parseArgs(['--env-file', 'a.env', '--no-env-file']), /cannot|together|conflict/i)
})

test('usage documents the release command, flags and stdout contract', () => {
  const text = usage()
  assert.match(text, /Usage: npm run release:android -- \[options\]/)
  for (const flag of ['--json', '--env-file <path>', '--no-env-file', '--help']) {
    assert.ok(text.includes(flag), `usage is missing ${flag}`)
  }
  assert.match(text, /dist\/QQPet-<version>\.apk/)
})

test('env files support comments, export, quotes, inline comments and CRLF', () => {
  const parsed = parseEnvFile(
    [
      '# full-line comment',
      '',
      'PLAIN=value',
      'export EXPORTED=yes',
      'SPACES="two words"',
      "SINGLE='literal $value'",
      'HASH=pa#ss',
      'TRAILING=value # trailing comment',
      'ESCAPED="a\\"b"',
      'CRLF=ok\r',
    ].join('\n'),
  )
  assert.equal(parsed.get('PLAIN'), 'value')
  assert.equal(parsed.get('EXPORTED'), 'yes')
  assert.equal(parsed.get('SPACES'), 'two words')
  assert.equal(parsed.get('SINGLE'), 'literal $value')
  assert.equal(parsed.get('HASH'), 'pa#ss')
  assert.equal(parsed.get('TRAILING'), 'value')
  assert.equal(parsed.get('ESCAPED'), 'a"b')
  assert.equal(parsed.get('CRLF'), 'ok')
})

test('double-quoted shell escapes stay literal except backslash and quote', () => {
  const parsed = parseEnvFile('PW="a\\nb"\nESC="a\\\\b"\nQUOTE="a\\"b"\nDOLLAR="cost $5"\n')
  assert.equal(parsed.get('PW'), 'a\\nb', '\\n stays a literal backslash+n like shell double quotes')
  assert.equal(parsed.get('ESC'), 'a\\b')
  assert.equal(parsed.get('QUOTE'), 'a"b')
  assert.equal(parsed.get('DOLLAR'), 'cost $5')
})

test('env files fail explicitly on malformed lines without echoing their content', () => {
  assert.throws(() => parseEnvFile('NOT AN ASSIGNMENT'), /line 1/)
  assert.throws(() => parseEnvFile('GOOD=1\n1BAD=value'), /line 2/)
  assert.throws(() => parseEnvFile('QUOTED="unterminated'), /unterminated|quote/i)
  assert.throws(() => parseEnvFile('SPACED = value'), /line 1/)
  try {
    parseEnvFile('LEAK="unterminated-fixture-secret"')
  } catch (error) {
    assert.ok(!error.message.includes('unterminated-fixture-secret'), 'error must not echo the value')
  }
})

test('release env prefers explicit environment over the default home file', (t) => {
  const fx = fixture(t)
  const file = join(fx.home, '.qqpet-release', 'release.env')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, 'ANDROID_KEY_ALIAS=from-file\nNEW_VALUE=from-file\n')
  const input = { ANDROID_KEY_ALIAS: 'from-env' }
  const resolved = resolveReleaseEnv({ env: input, homedir: fx.home })
  assert.equal(resolved.path, file)
  assert.equal(resolved.env.ANDROID_KEY_ALIAS, 'from-env')
  assert.equal(resolved.env.NEW_VALUE, 'from-file')
  assert.equal(input.NEW_VALUE, undefined, 'the caller environment must not be mutated')
})

test('a missing default env file is optional but explicit paths must exist', (t) => {
  const fx = fixture(t)
  assert.deepEqual(resolveReleaseEnv({ env: {}, homedir: fx.home }), { path: null, env: {} })
  assert.throws(
    () => resolveReleaseEnv({ env: {}, homedir: fx.home, envFile: join(fx.base, 'missing.env') }),
    /not found/i,
  )
  assert.throws(
    () => resolveReleaseEnv({ env: { QQPET_RELEASE_ENV: join(fx.base, 'missing.env') }, homedir: fx.home }),
    /not found/i,
  )
  assert.equal(
    resolveReleaseEnv({ env: { QQPET_RELEASE_ENV: join(fx.base, 'missing.env') }, homedir: fx.home, noEnvFile: true }).path,
    null,
  )
})

test('release env file values reach the build but never the output', (t) => {
  const fx = fixture(t)
  const file = join(fx.base, 'release.env')
  writeFileSync(
    file,
    [
      `ANDROID_KEYSTORE=${fx.keystore}`,
      `ANDROID_KEYSTORE_PASSWORD="${SECRET}"`,
      'ANDROID_KEY_ALIAS=fixture-alias',
      `ANDROID_KEY_PASSWORD="${SECRET}"`,
    ].join('\n'),
  )
  const env = baseEnv(fx, {
    ANDROID_KEYSTORE: undefined,
    ANDROID_KEYSTORE_PASSWORD: undefined,
    ANDROID_KEY_ALIAS: undefined,
    ANDROID_KEY_PASSWORD: undefined,
  })
  const ctx = context(fx, [], { env })
  const code = main(['--json', '--env-file', file], ctx.deps)
  assert.equal(code, 0)
  const gradle = ctx.calls.find((call) => call.command === './gradlew')
  assert.equal(gradle.options.env.ANDROID_KEYSTORE_PASSWORD, SECRET)
  const visible = [...ctx.logs, ...ctx.prints].join('\n')
  assert.ok(visible.includes(file), 'the env file path is logged')
  assert.ok(!visible.includes(SECRET), 'env file values must never be printed')
  assert.ok(!JSON.stringify(ctx.prints).includes('fixture-keystore'), 'summary must not echo credential paths')
})

test('explicit environment values win over the release env file', (t) => {
  const fx = fixture(t)
  const file = join(fx.base, 'release.env')
  writeFileSync(file, `ANDROID_KEYSTORE_PASSWORD="${SECRET}"\n`)
  const env = baseEnv(fx, { ANDROID_KEYSTORE_PASSWORD: 'fixture-explicit-password' })
  const ctx = context(fx, [], { env })
  assert.equal(main(['--env-file', file], ctx.deps), 0)
  const gradle = ctx.calls.find((call) => call.command === './gradlew')
  assert.equal(gradle.options.env.ANDROID_KEYSTORE_PASSWORD, 'fixture-explicit-password')
  assert.ok(![...ctx.logs, ...ctx.prints].join('\n').includes(SECRET))
})

test('--no-env-file ignores configured env files', (t) => {
  const fx = fixture(t)
  const file = join(fx.home, '.qqpet-release', 'release.env')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, 'THIS IS NOT VALID\n')
  const ctx = context(fx)
  assert.equal(main(['--json', '--no-env-file'], ctx.deps), 0)
})

/* ------------------------------------------------------------------ *
 * Preflight: version, JDK, SDK, signing, wrapper
 * ------------------------------------------------------------------ */

test('non-semantic package versions fail before any build command', (t) => {
  const fx = fixture(t, { version: '0.20' })
  const ctx = context(fx)
  assert.throws(() => runReleaseAndroid({}, ctx.deps), /semantic version/i)
  assert.equal(ctx.calls.length, 0)
})

test('JAVA_HOME is verified: Java 11 is rejected and Java 17 on PATH is used', (t) => {
  const fx = fixture(t)
  const jdk11 = join(fx.base, 'jdk11')
  mkdirSync(join(jdk11, 'bin'), { recursive: true })
  writeFileSync(join(jdk11, 'bin', 'java'), '')
  fx.env = baseEnv(fx, { JAVA_HOME: jdk11, PATH: join(fx.javaHome, 'bin') })
  const ctx = context(fx)
  const summary = runReleaseAndroid({}, ctx.deps)
  assert.equal(summary.ok, true)
  const gradle = ctx.calls.find((call) => call.command === './gradlew')
  assert.equal(gradle.options.env.JAVA_HOME, fx.javaHome)
})

test('no Java 17 candidate fails preflight instead of using an older JDK', (t) => {
  const fx = fixture(t)
  const jdk11 = join(fx.base, 'jdk11')
  mkdirSync(join(jdk11, 'bin'), { recursive: true })
  writeFileSync(join(jdk11, 'bin', 'java'), '')
  fx.env = baseEnv(fx, { JAVA_HOME: jdk11, PATH: join(jdk11, 'bin') })
  const ctx = context(fx)
  assert.throws(() => runReleaseAndroid({}, ctx.deps), /Java 17/i)
  assert.equal(buildCalls(ctx.calls).length, 0)
})

test('macOS falls back to /usr/libexec/java_home -v 17 and verifies it', (t) => {
  const fx = fixture(t)
  const emptyPath = join(fx.base, 'empty-bin')
  mkdirSync(emptyPath, { recursive: true })
  fx.env = baseEnv(fx, { JAVA_HOME: undefined, PATH: emptyPath })
  const ctx = context(
    fx,
    [
      handler(
        (command, args) => command === '/usr/libexec/java_home' && args.join(' ') === '-v 17',
        () => ({ status: 0, stdout: `${fx.javaHome}\n`, stderr: '' }),
      ),
    ],
    { platform: 'darwin' },
  )
  const summary = runReleaseAndroid({}, ctx.deps)
  assert.equal(summary.ok, true)
  const gradle = ctx.calls.find((call) => call.command === './gradlew')
  assert.equal(gradle.options.env.JAVA_HOME, fx.javaHome)
})

test('a missing Android SDK fails preflight before the build', (t) => {
  const fx = fixture(t)
  const missing = join(fx.base, 'missing-sdk')
  fx.env = baseEnv(fx, { ANDROID_HOME: missing, ANDROID_SDK_ROOT: missing })
  const ctx = context(fx, [], { sdkCandidates: [missing] })
  assert.throws(() => runReleaseAndroid({}, ctx.deps), /Android SDK/i)
  assert.equal(buildCalls(ctx.calls).length, 0)
})

test('an SDK build-tools version needs both apksigner and aapt2', (t) => {
  const fx = fixture(t, { aapt2: false })
  const ctx = context(fx, [], { sdkCandidates: [fx.sdk] })
  assert.throws(() => runReleaseAndroid({}, ctx.deps), /aapt2/i)
  assert.equal(buildCalls(ctx.calls).length, 0)
})

test('the newest complete build-tools version is selected', (t) => {
  const fx = fixture(t)
  for (const version of ['34.0.0', '36.0.0']) {
    mkdirSync(join(fx.sdk, 'build-tools', version), { recursive: true })
  }
  for (const tool of ['apksigner', 'aapt2']) {
    writeFileSync(join(fx.sdk, 'build-tools', '34.0.0', tool), '')
  }
  writeFileSync(join(fx.sdk, 'build-tools', '36.0.0', 'apksigner'), '')
  const ctx = context(fx)
  const summary = runReleaseAndroid({}, ctx.deps)
  assert.equal(summary.ok, true)
  const apksigner = ctx.calls.find((call) => call.command.endsWith('/apksigner'))
  assert.equal(apksigner.command, join(fx.sdk, 'build-tools', '35.0.0', 'apksigner'))
})

test('missing release signing fails preflight with both configuration options', (t) => {
  const fx = fixture(t)
  fx.env = baseEnv(fx, {
    ANDROID_KEYSTORE: undefined,
    ANDROID_KEYSTORE_PASSWORD: undefined,
    ANDROID_KEY_ALIAS: undefined,
    ANDROID_KEY_PASSWORD: undefined,
  })
  const ctx = context(fx)
  assert.throws(() => runReleaseAndroid({}, ctx.deps), /signing is not configured/i)
  assert.equal(buildCalls(ctx.calls).length, 0)
})

test('partial signing environment fails and names the missing variables', (t) => {
  const fx = fixture(t)
  fx.env = baseEnv(fx, { ANDROID_KEY_ALIAS: undefined })
  const ctx = context(fx)
  assert.throws(() => runReleaseAndroid({}, ctx.deps), /ANDROID_KEY_ALIAS/)
  assert.equal(buildCalls(ctx.calls).length, 0)
})

test('a complete signing environment must point at an existing keystore', (t) => {
  const fx = fixture(t, { keystore: false })
  const ctx = context(fx)
  assert.throws(() => runReleaseAndroid({}, ctx.deps), /ANDROID_KEYSTORE.*does not exist/i)
  assert.equal(buildCalls(ctx.calls).length, 0)
})

test('android/keystore.properties alone satisfies the signing preflight', (t) => {
  const fx = fixture(t, { keystoreProperties: true })
  fx.env = baseEnv(fx, {
    ANDROID_KEYSTORE: undefined,
    ANDROID_KEYSTORE_PASSWORD: undefined,
    ANDROID_KEY_ALIAS: undefined,
    ANDROID_KEY_PASSWORD: undefined,
  })
  const ctx = context(fx)
  assert.equal(runReleaseAndroid({}, ctx.deps).ok, true)
})

test('a missing or non-executable Gradle wrapper fails preflight', (t) => {
  const missing = fixture(t)
  rmSync(missing.gradlew)
  const missingCtx = context(missing)
  assert.throws(() => runReleaseAndroid({}, missingCtx.deps), /gradlew/i)
  assert.equal(buildCalls(missingCtx.calls).length, 0)

  const notExecutable = fixture(t, { gradleExecutable: false })
  const notExecutableCtx = context(notExecutable)
  assert.throws(() => runReleaseAndroid({}, notExecutableCtx.deps), /gradlew.*executable|executable.*gradlew/i)
  assert.equal(buildCalls(notExecutableCtx.calls).length, 0)
})

/* ------------------------------------------------------------------ *
 * Orchestration, verification, archiving
 * ------------------------------------------------------------------ */

test('release orchestration runs typecheck, web build and gradle, then verifies and archives', (t) => {
  const fx = fixture(t)
  const ctx = context(fx)
  const summary = runReleaseAndroid({}, ctx.deps)
  assert.deepEqual(
    buildCalls(ctx.calls).map((call) => `${call.command} ${call.args.join(' ')}`),
    ['npm run typecheck', 'npm run build:android-web', './gradlew assembleRelease'],
  )
  const typecheck = ctx.calls.find(npmCall('typecheck'))
  assert.equal(typecheck.options.cwd, fx.root)
  assert.equal(typecheck.options.env.QQPET_VERSION, undefined)
  const web = ctx.calls.find(npmCall('build:android-web'))
  assert.equal(web.options.env.QQPET_VERSION, VERSION)
  const gradle = ctx.calls.find((call) => call.command === './gradlew')
  assert.equal(gradle.options.cwd, join(fx.root, 'android'))
  assert.equal(gradle.options.env.JAVA_HOME, fx.javaHome)
  assert.equal(gradle.options.env.ANDROID_HOME, fx.sdk)
  assert.equal(gradle.options.env.ANDROID_SDK_ROOT, fx.sdk)
  assert.equal(gradle.options.env.PATH.split(delimiter)[0], join(fx.javaHome, 'bin'))
  assert.match(
    readFileSync(join(fx.root, 'android', 'local.properties'), 'utf8'),
    new RegExp(`^sdk\\.dir=${fx.sdk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'),
  )
  const apksigner = ctx.calls.find((call) => call.command.endsWith('/apksigner'))
  assert.deepEqual(apksigner.args, ['verify', '--print-certs', fx.apk])
  assert.equal(apksigner.options.stdio, 'pipe')
  assert.equal(apksigner.options.env.JAVA_HOME, fx.javaHome, 'apksigner runs on the verified JDK 17')
  assert.equal(apksigner.options.env.ANDROID_HOME, fx.sdk)
  assert.equal(apksigner.options.env.ANDROID_SDK_ROOT, fx.sdk)
  assert.equal(apksigner.options.env.PATH.split(delimiter)[0], join(fx.javaHome, 'bin'))
  const aapt2 = ctx.calls.find((call) => call.command.endsWith('/aapt2'))
  assert.deepEqual(aapt2.args, ['dump', 'badging', fx.apk])
  assert.equal(aapt2.options.stdio, 'pipe')
  assert.equal(aapt2.options.env.JAVA_HOME, fx.javaHome)
  assert.equal(aapt2.options.env.ANDROID_HOME, fx.sdk)
  assert.equal(aapt2.options.env.ANDROID_SDK_ROOT, fx.sdk)
  const archived = distPath(fx)
  assert.equal(readFileSync(archived, 'utf8'), APK_BYTES)
  assert.deepEqual(readdirSync(join(fx.root, 'dist')), [`QQPet-${VERSION}.apk`], 'no temporary archive files remain')
  assert.deepEqual(summary, {
    ok: true,
    target: 'android',
    version: VERSION,
    apk: archived,
    sha256: sha256(APK_BYTES),
    packageName: PACKAGE_NAME,
    versionName: VERSION,
    signer: DN,
    certificateSha256: CERT_SHA256,
  })
  assert.ok(ctx.logs.length > 0, 'progress is reported')
})

test('a missing certificate SHA-256 digest is reported as null, never invented', (t) => {
  const fx = fixture(t)
  const hideDigest = () =>
    handler(
      (command) => command.endsWith('/apksigner'),
      () => ({ status: 0, stdout: `Signer #1 certificate DN: ${DN}\n`, stderr: '' }),
    )
  const summary = runReleaseAndroid({}, context(fx, [hideDigest()]).deps)
  assert.equal(summary.signer, DN)
  assert.equal(summary.certificateSha256, null)
  const human = context(fx, [hideDigest()])
  assert.equal(main([], human.deps), 0)
  assert.ok(human.prints.join('\n').includes('certificateSha256: (unavailable)'))
})

test('an existing android/local.properties is validated, never overwritten', (t) => {
  const fx = fixture(t)
  writeFileSync(join(fx.root, 'android', 'local.properties'), `# user config\nsdk.dir=${fx.sdk}\n`)
  const ctx = context(fx)
  runReleaseAndroid({}, ctx.deps)
  assert.equal(
    readFileSync(join(fx.root, 'android', 'local.properties'), 'utf8'),
    `# user config\nsdk.dir=${fx.sdk}\n`,
  )
})

test('a local.properties sdk.dir pointing at a missing directory fails explicitly', (t) => {
  const fx = fixture(t)
  writeFileSync(join(fx.root, 'android', 'local.properties'), `sdk.dir=${join(fx.base, 'gone')}\n`)
  const ctx = context(fx)
  assert.throws(() => runReleaseAndroid({}, ctx.deps), /sdk\.dir/i)
  assert.equal(buildCalls(ctx.calls).length, 0)
})

test('a failed build preserves the previous successful APK and leaves no temporary file', (t) => {
  const fx = fixture(t)
  mkdirSync(join(fx.root, 'dist'), { recursive: true })
  writeFileSync(distPath(fx), 'previous-good-apk')
  const ctx = context(fx, [handler((command) => command === './gradlew', () => ({ status: 1, stdout: '', stderr: '' }))])
  assert.throws(() => runReleaseAndroid({}, ctx.deps), /assembleRelease.*failed|failed.*assembleRelease/i)
  assert.equal(readFileSync(distPath(fx), 'utf8'), 'previous-good-apk')
  assert.deepEqual(readdirSync(join(fx.root, 'dist')), [`QQPet-${VERSION}.apk`])
})

test('a typecheck failure stops before the web build, gradle, and archiving', (t) => {
  const fx = fixture(t)
  const ctx = context(fx, [handler(isNpm('typecheck'), () => ({ status: 1, stdout: '', stderr: '' }))])
  assert.throws(() => runReleaseAndroid({}, ctx.deps), /typecheck.*failed|failed.*typecheck/i)
  assert.equal(ctx.calls.filter(npmCall('build:android-web')).length, 0)
  assert.equal(ctx.calls.filter((call) => call.command === './gradlew').length, 0)
  assert.equal(existsSync(distPath(fx)), false)
})

test('a gradle failure stops before verification and archiving', (t) => {
  const fx = fixture(t)
  const ctx = context(fx, [handler((command) => command === './gradlew', () => ({ status: 1, stdout: '', stderr: '' }))])
  assert.throws(() => runReleaseAndroid({}, ctx.deps), /assembleRelease.*failed|failed.*assembleRelease/i)
  assert.equal(ctx.calls.filter((call) => call.command.endsWith('/apksigner')).length, 0)
  assert.equal(existsSync(distPath(fx)), false)
})

test('a missing Gradle APK fails without archiving', (t) => {
  const fx = fixture(t)
  const ctx = context(fx, [
    handler((command) => command === './gradlew', () => ({ status: 0, stdout: '', stderr: '' })),
  ])
  assert.throws(() => runReleaseAndroid({}, ctx.deps), /app-release\.apk|not.*produced|missing/i)
  assert.equal(existsSync(distPath(fx)), false)
})

test('apksigner verification failure refuses to archive the APK', (t) => {
  const fx = fixture(t)
  const ctx = context(fx, [
    handler((command) => command.endsWith('/apksigner'), () => ({ status: 1, stdout: '', stderr: 'insecure signature' })),
  ])
  assert.throws(() => runReleaseAndroid({}, ctx.deps), /apksigner.*failed|verification failed/i)
  assert.equal(existsSync(distPath(fx)), false)
})

test('a wrong APK package name refuses to archive the APK', (t) => {
  const fx = fixture(t)
  const ctx = context(fx, [
    handler((command) => command.endsWith('/aapt2'), () => ({
      status: 0,
      stdout: "package: name='com.example.other' versionCode='1' versionName='0.20.0'\n",
      stderr: '',
    })),
  ])
  assert.throws(() => runReleaseAndroid({}, ctx.deps), /package name/i)
  assert.equal(existsSync(distPath(fx)), false)
})

test('a wrong APK versionName refuses to archive the APK', (t) => {
  const fx = fixture(t)
  const ctx = context(fx, [
    handler((command) => command.endsWith('/aapt2'), () => ({
      status: 0,
      stdout: `package: name='${PACKAGE_NAME}' versionCode='1' versionName='0.19.0'\n`,
      stderr: '',
    })),
  ])
  assert.throws(() => runReleaseAndroid({}, ctx.deps), /versionName/i)
  assert.equal(existsSync(distPath(fx)), false)
})

/* ------------------------------------------------------------------ *
 * CLI summary contract
 * ------------------------------------------------------------------ */

test('--json writes exactly one JSON summary to stdout and progress to stderr', (t) => {
  const fx = fixture(t)
  const ctx = context(fx)
  const code = main(['--json'], ctx.deps)
  assert.equal(code, 0)
  assert.equal(ctx.prints.length, 1)
  const summary = JSON.parse(ctx.prints[0])
  assert.equal(summary.ok, true)
  assert.equal(summary.apk, distPath(fx))
  assert.equal(summary.certificateSha256, CERT_SHA256)
  assert.ok(ctx.logs.length > 0, 'progress goes to stderr')
  assert.equal(ctx.calls.find(npmCall('typecheck')).options.stdio, 'stderr')
  assert.equal(ctx.calls.find((call) => call.command === './gradlew').options.stdio, 'stderr')
  assert.equal(ctx.calls.filter((call) => call.options.stdio === 'inherit').length, 0, 'no child may inherit stdout in JSON mode')
})

test('human mode inherits stdio for long build steps', (t) => {
  const fx = fixture(t)
  const ctx = context(fx)
  assert.equal(main([], ctx.deps), 0)
  assert.equal(ctx.calls.find(npmCall('typecheck')).options.stdio, 'inherit')
  assert.equal(ctx.calls.find((call) => call.command === './gradlew').options.stdio, 'inherit')
  assert.ok(ctx.prints.join('\n').includes(`QQPet-${VERSION}.apk`))
  assert.ok(ctx.prints.join('\n').includes(`certificateSha256: ${CERT_SHA256}`))
})

test('--json failures still emit one JSON summary, exit 1, and never archive', (t) => {
  const fx = fixture(t)
  fx.env = baseEnv(fx, {
    ANDROID_KEYSTORE: undefined,
    ANDROID_KEYSTORE_PASSWORD: undefined,
    ANDROID_KEY_ALIAS: undefined,
    ANDROID_KEY_PASSWORD: undefined,
  })
  const ctx = context(fx)
  const code = main(['--json', '--no-env-file'], ctx.deps)
  assert.equal(code, 1)
  assert.equal(ctx.prints.length, 1)
  const payload = JSON.parse(ctx.prints[0])
  assert.deepEqual(Object.keys(payload).sort(), ['error', 'ok'])
  assert.equal(payload.ok, false)
  assert.match(payload.error, /signing is not configured/i)
  assert.ok(ctx.logs.join('\n').includes('error:'))
  assert.equal(existsSync(distPath(fx)), false)
})

test('--help exits 0 without touching the toolchain', (t) => {
  const fx = fixture(t)
  const ctx = context(fx)
  assert.equal(main(['--help'], ctx.deps), 0)
  assert.match(ctx.prints[0], /Usage: npm run release:android/)
  assert.equal(ctx.calls.length, 0)
})

test('bad arguments exit 1 with usage, or JSON when --json is present', (t) => {
  const fx = fixture(t)
  const human = context(fx)
  assert.equal(main(['--bogus'], human.deps), 1)
  assert.equal(human.prints.length, 0)
  assert.match(human.logs.join('\n'), /error:.*unknown argument/i)
  assert.match(human.logs.join('\n'), /Usage: npm run release:android/)

  const json = context(fx)
  assert.equal(main(['--json', '--bogus'], json.deps), 1)
  assert.equal(json.prints.length, 1)
  assert.deepEqual(Object.keys(JSON.parse(json.prints[0])).sort(), ['error', 'ok'])
  assert.equal(JSON.parse(json.prints[0]).ok, false)
})

test('the thin CLI entry exposes --help and JSON argument failures', () => {
  const cli = fileURLToPath(new URL('../build-android-release.mjs', import.meta.url))
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /Usage: npm run release:android/)
  const invalid = spawnSync(process.execPath, [cli, '--json', '--bogus'], { encoding: 'utf8' })
  assert.equal(invalid.status, 1)
  const payload = JSON.parse(invalid.stdout)
  assert.equal(payload.ok, false)
  assert.match(payload.error, /unknown argument/i)
})

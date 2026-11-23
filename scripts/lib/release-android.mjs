import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repository root, resolved from this module so the CLI never depends on cwd. */
export const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

export const TARGET = 'android'
export const PACKAGE_NAME = 'net.ankio.qqpet'
export const SEMANTIC_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
export const SIGNING_ENVIRONMENT = [
  'ANDROID_KEYSTORE',
  'ANDROID_KEYSTORE_PASSWORD',
  'ANDROID_KEY_ALIAS',
  'ANDROID_KEY_PASSWORD',
]
export const RELEASE_APK = join('android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')

export class ReleaseError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ReleaseError'
  }
}

export function usage() {
  return [
    'Usage: npm run release:android -- [options]',
    '',
    'Build, verify and archive a signed production Android release APK.',
    'The release env file is $QQPET_RELEASE_ENV, otherwise ~/.qqpet-release/release.env',
    'when it exists. Variables already set in the environment always win.',
    '',
    'Options:',
    '  --json              Print only a JSON summary on stdout; progress stays on stderr',
    '  --env-file <path>   Load release environment variables from <path>',
    '  --no-env-file       Do not load $QQPET_RELEASE_ENV or ~/.qqpet-release/release.env',
    '  --help              Show this help',
    '',
    'The verified APK is copied to dist/QQPet-<version>.apk and its SHA-256 is printed.',
    'Failures exit 1 and never archive an unsigned or unverified APK.',
    '',
    'Machine-readable output: npm run --silent release:android -- --json',
    '(npm prints its script banner to stdout unless --silent is used).',
  ].join('\n')
}

export function parseArgs(argv) {
  const options = { json: false, help: false, envFile: null, noEnvFile: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      options.json = true
      continue
    }
    if (arg === '--help') {
      options.help = true
      continue
    }
    if (arg === '--no-env-file') {
      options.noEnvFile = true
      continue
    }
    if (arg === '--env-file' || arg.startsWith('--env-file=')) {
      let value
      if (arg.startsWith('--env-file=')) value = arg.slice('--env-file='.length)
      else {
        value = argv[index + 1]
        if (value === undefined || value.startsWith('--')) throw new ReleaseError('Missing value for --env-file.')
        index += 1
      }
      if (!value) throw new ReleaseError('Missing value for --env-file.')
      if (options.envFile !== null && options.envFile !== value) {
        throw new ReleaseError('--env-file may only be given once.')
      }
      options.envFile = value
      continue
    }
    throw new ReleaseError(`Unknown argument: ${arg}.`)
  }
  if (options.envFile !== null && options.noEnvFile) {
    throw new ReleaseError('--env-file and --no-env-file cannot be used together.')
  }
  return options
}

function parseEnvValue(raw, lineNumber, source) {
  const value = raw.trim()
  if (value.startsWith('"')) {
    const end = findClosingDoubleQuote(value)
    if (end === -1) throw new ReleaseError(`Invalid ${source} at line ${lineNumber}: unterminated double quote.`)
    const rest = value.slice(end + 1).trim()
    if (rest && !rest.startsWith('#')) {
      throw new ReleaseError(`Invalid ${source} at line ${lineNumber}: unexpected text after closing quote.`)
    }
    return unescapeDoubleQuoted(value.slice(1, end))
  }
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1)
    if (end === -1) throw new ReleaseError(`Invalid ${source} at line ${lineNumber}: unterminated single quote.`)
    const rest = value.slice(end + 1).trim()
    if (rest && !rest.startsWith('#')) {
      throw new ReleaseError(`Invalid ${source} at line ${lineNumber}: unexpected text after closing quote.`)
    }
    return value.slice(1, end)
  }
  const comment = value.search(/\s#/)
  return (comment === -1 ? value : value.slice(0, comment)).trim()
}

function findClosingDoubleQuote(value) {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === '\\') {
      index += 1
      continue
    }
    if (value[index] === '"') return index
  }
  return -1
}

function unescapeDoubleQuoted(value) {
  // Shell double quotes only remove the backslash before another backslash or a
  // quote. "\n" stays two literal characters, so passwords survive verbatim;
  // $ and backticks are intentionally not expanded by this CLI.
  return value.replace(/\\([\\"])/g, '$1')
}

/**
 * Parse the shell-like `KEY=VALUE` subset used by ~/.qqpet-release/release.env.
 * Comments, `export `, single/double quotes and inline comments are supported.
 * Errors report only the line number, never the value.
 */
export function parseEnvFile(text, source = 'release env file') {
  const assignments = new Map()
  const lines = String(text).split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index].replace(/\r$/, '')
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    line = trimmed.startsWith('export ') ? trimmed.slice('export '.length) : trimmed
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!match) throw new ReleaseError(`Invalid ${source} at line ${index + 1}: expected KEY=VALUE.`)
    assignments.set(match[1], parseEnvValue(match[2], index + 1, source))
  }
  return assignments
}

/**
 * Merge the release env file into the current environment without overriding
 * variables that are already present. Returns the path that was loaded (for
 * logging) and a new environment object; the caller's object is not mutated.
 */
export function resolveReleaseEnv({
  env = {},
  envFile = null,
  noEnvFile = false,
  homedir = osHomedir(),
} = {}) {
  if (envFile !== null && noEnvFile) {
    throw new ReleaseError('--env-file and --no-env-file cannot be used together.')
  }
  const merged = { ...env }
  if (noEnvFile) return { path: null, env: merged }

  let path = null
  if (envFile !== null) {
    path = isAbsolute(envFile) ? envFile : resolve(envFile)
    assertEnvFile(path)
  } else if (env.QQPET_RELEASE_ENV) {
    path = isAbsolute(env.QQPET_RELEASE_ENV) ? env.QQPET_RELEASE_ENV : resolve(env.QQPET_RELEASE_ENV)
    assertEnvFile(path)
  } else {
    const fallback = join(homedir, '.qqpet-release', 'release.env')
    if (isFile(fallback)) path = fallback
  }
  if (path === null) return { path: null, env: merged }

  for (const [key, value] of parseEnvFile(readFileSync(path, 'utf8'), path)) {
    if (merged[key] === undefined) merged[key] = value
  }
  return { path, env: merged }
}

function assertEnvFile(path) {
  if (!isFile(path)) throw new ReleaseError(`Release environment file not found: ${path}`)
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function readPackageVersion(root) {
  const file = join(root, 'package.json')
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (!existsSync(file)) throw new ReleaseError(`Cannot read ${file}.`)
    throw new ReleaseError(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const version = typeof parsed.version === 'string' ? parsed.version.trim() : ''
  const match = SEMANTIC_VERSION.exec(version)
  if (!match || match[4]?.split('.').some((part) => /^0\d+$/.test(part))) {
    throw new ReleaseError(`package.json version must be a semantic version (found '${version || '(missing)'}').`)
  }
  return version
}

/* ------------------------------------------------------------------ *
 * Toolchain discovery (injectable through deps for tests)
 * ------------------------------------------------------------------ */

function executableName(name, platform) {
  if (platform !== 'win32') return name
  return `${name}.exe`
}

function findExecutable(searchPath, name, platform) {
  const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const entry of String(searchPath ?? '').split(delimiter)) {
    if (!entry) continue
    for (const extension of extensions) {
      const candidate = join(entry, `${name}${extension}`)
      if (isFile(candidate)) return candidate
    }
  }
  return null
}

function parseJavaVersion(text) {
  const match = /version "(\d+)(?:\.(\d+))?/.exec(text)
  if (!match) return null
  const first = Number(match[1])
  return first === 1 ? Number(match[2]) : first
}

function parseJavaHome(text) {
  const match = /^\s*java\.home\s*=\s*(.+)$/m.exec(text)
  return match?.[1]?.trim() || null
}

function probeJava(run, javaPath, fallbackHome, env) {
  if (!isFile(javaPath)) return null
  // Probe the candidate in isolation: a jenv/asdf shim must not answer with a
  // different JDK just because another candidate's JAVA_HOME is still exported.
  const probeEnv = { ...env }
  delete probeEnv.JAVA_HOME
  let result
  try {
    result = run(javaPath, ['-XshowSettings:properties', '-version'], {
      stdio: 'pipe',
      env: probeEnv,
    })
  } catch {
    return null
  }
  if (result.status !== 0) return null
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const version = parseJavaVersion(output)
  if (version === null) return null
  return { home: parseJavaHome(output) ?? fallbackHome, version }
}

export function resolveJava(run, env = {}, platform = process.platform) {
  const rejected = []
  const candidate = (home, source) => {
    if (!home) return null
    const probe = probeJava(run, join(home, 'bin', executableName('java', platform)), home, env)
    if (probe?.version === 17) return { home: probe.home ?? home, version: probe.version, source }
    rejected.push(probe ? `${source} is Java ${probe.version}` : `${source} is not a usable JDK`)
    return null
  }

  const fromJavaHome = candidate(env.JAVA_HOME, 'JAVA_HOME')
  if (fromJavaHome) return fromJavaHome

  const onPath = findExecutable(env.PATH, 'java', platform)
  if (onPath) {
    const probe = probeJava(run, onPath, dirname(dirname(onPath)), env)
    if (probe?.version === 17) return { home: probe.home, version: probe.version, source: 'java on PATH' }
    rejected.push(probe ? `java on PATH is Java ${probe.version}` : 'java on PATH is not a usable JDK')
  } else {
    rejected.push('java is not on PATH')
  }

  if (platform === 'darwin') {
    let result = null
    try {
      result = run('/usr/libexec/java_home', ['-v', '17'], { stdio: 'pipe' })
    } catch {
      result = null
    }
    const home = result?.status === 0 ? result.stdout?.trim().split('\n')[0] : null
    if (home) {
      const fromJavaHome = candidate(home, '/usr/libexec/java_home -v 17')
      if (fromJavaHome) return fromJavaHome
    } else {
      rejected.push('/usr/libexec/java_home -v 17 did not return a JDK')
    }
  }

  throw new ReleaseError(
    `Java 17 is required to build the Android release (${rejected.join('; ')}). ` +
      'Install a JDK 17 and set JAVA_HOME or put its bin directory first on PATH.',
  )
}

export function defaultSdkCandidates(env = {}, home = osHomedir()) {
  return [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    join(home, 'Library', 'Android', 'sdk'),
    '/opt/homebrew/share/android-commandlinetools',
    join(home, 'Android', 'Sdk'),
  ].filter(Boolean)
}

function compareBuildTools(left, right) {
  const a = (left.match(/\d+/g) ?? []).map(Number)
  const b = (right.match(/\d+/g) ?? []).map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return left.localeCompare(right)
}

function findBuildTools(sdk) {
  const toolsDirectory = join(sdk, 'build-tools')
  if (!isDirectory(toolsDirectory)) return null
  const versions = readdirSync(toolsDirectory)
    .filter((version) => isDirectory(join(toolsDirectory, version)))
    .sort(compareBuildTools)
  for (let index = versions.length - 1; index >= 0; index -= 1) {
    const version = versions[index]
    const directory = join(toolsDirectory, version)
    const apksigner = join(directory, 'apksigner')
    const aapt2 = join(directory, 'aapt2')
    if (isFile(apksigner) && isFile(aapt2)) return { version, apksigner, aapt2 }
  }
  return null
}

export function resolveAndroidSdk({ sdkCandidates } = {}, env = {}, home = osHomedir()) {
  const candidates = sdkCandidates ?? defaultSdkCandidates(env, home)
  const seen = new Set()
  const checked = []
  for (const candidate of candidates) {
    if (!candidate) continue
    const sdk = resolve(candidate)
    if (seen.has(sdk)) continue
    seen.add(sdk)
    if (!isDirectory(sdk)) {
      checked.push(`${sdk} (missing)`)
      continue
    }
    const buildTools = findBuildTools(sdk)
    if (buildTools) return { sdk, buildTools }
    checked.push(`${sdk} (no build-tools version with apksigner and aapt2)`)
  }
  throw new ReleaseError(
    'Android SDK with apksigner and aapt2 is required to verify the release APK; ' +
      `checked ${checked.join(', ') || '(no candidates)'}. Set ANDROID_HOME to a complete SDK.`,
  )
}

function resolveSigning(root, env) {
  const properties = join(root, 'android', 'keystore.properties')
  const present = SIGNING_ENVIRONMENT.filter((key) => Boolean(env[key]))
  if (isFile(properties)) {
    if (env.ANDROID_KEYSTORE && !isFile(env.ANDROID_KEYSTORE)) {
      throw new ReleaseError(`ANDROID_KEYSTORE does not exist: ${env.ANDROID_KEYSTORE}.`)
    }
    return { source: 'android/keystore.properties' }
  }
  if (present.length === 0) {
    throw new ReleaseError(
      'Release signing is not configured. Set ANDROID_KEYSTORE, ANDROID_KEYSTORE_PASSWORD, ' +
        'ANDROID_KEY_ALIAS and ANDROID_KEY_PASSWORD, or create android/keystore.properties ' +
        '(gitignored) with storeFile/storePassword/keyAlias/keyPassword.',
    )
  }
  if (present.length < SIGNING_ENVIRONMENT.length) {
    const missing = SIGNING_ENVIRONMENT.filter((key) => !env[key])
    throw new ReleaseError(`Release signing is incomplete: missing ${missing.join(', ')}.`)
  }
  if (!isFile(env.ANDROID_KEYSTORE)) {
    throw new ReleaseError(`ANDROID_KEYSTORE does not exist: ${env.ANDROID_KEYSTORE}.`)
  }
  return { source: 'environment' }
}

function resolveGradleWrapper(root) {
  const wrapper = join(root, 'android', 'gradlew')
  if (!isFile(wrapper)) throw new ReleaseError(`Gradle wrapper is missing: ${wrapper}.`)
  if ((statSync(wrapper).mode & 0o111) === 0) {
    throw new ReleaseError(`Gradle wrapper is not executable: ${wrapper}.`)
  }
  return wrapper
}

function escapePropertiesPath(value) {
  return value.replace(/\\/g, '\\\\').replace(/ /g, '\\ ')
}

function unescapePropertiesPath(value) {
  return value.replace(/\\(.)/g, '$1')
}

function ensureLocalProperties(root, sdk) {
  const file = join(root, 'android', 'local.properties')
  if (!isFile(file)) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `sdk.dir=${escapePropertiesPath(sdk)}\n`)
    return { path: file, created: true }
  }
  const match = /^\s*sdk\.dir\s*=\s*(.*)$/m.exec(readFileSync(file, 'utf8'))
  if (!match) return { path: file, created: false }
  const configured = unescapePropertiesPath(match[1].trim())
  if (!configured) throw new ReleaseError('android/local.properties has an empty sdk.dir.')
  if (!isDirectory(configured)) {
    throw new ReleaseError(`android/local.properties sdk.dir does not exist: ${configured}.`)
  }
  return { path: file, created: false }
}

/* ------------------------------------------------------------------ *
 * Verification and archiving
 * ------------------------------------------------------------------ */

function verifyApk(run, tools, apk, version, env) {
  if (!isFile(apk)) throw new ReleaseError(`Release APK was not produced: ${apk}.`)
  if (statSync(apk).size === 0) throw new ReleaseError(`Release APK is empty: ${apk}.`)

  const verified = run(tools.apksigner, ['verify', '--print-certs', apk], { stdio: 'pipe', env })
  if (verified.status !== 0) {
    const detail = (verified.stderr || verified.stdout || '').trim()
    throw new ReleaseError(`apksigner verification failed for ${apk}${detail ? `: ${detail}` : '.'}`)
  }
  const signer = /Signer #1 certificate DN:\s*(.+)/.exec(verified.stdout)?.[1]?.trim() ?? null
  const certificateSha256 =
    /Signer #1 certificate SHA-256 digest:\s*([0-9a-fA-F:]+)/.exec(verified.stdout)?.[1]?.trim() ?? null

  const badging = run(tools.aapt2, ['dump', 'badging', apk], { stdio: 'pipe', env })
  const badgingText = `${badging.stdout ?? ''}${badging.stderr ?? ''}`
  const match = /package: name='([^']+)' versionCode='[^']*' versionName='([^']*)'/.exec(badgingText)
  if (badging.status !== 0 || !match) {
    throw new ReleaseError(`aapt2 dump badging did not report package metadata for ${apk}.`)
  }
  const [, packageName, versionName] = match
  if (packageName !== PACKAGE_NAME) {
    throw new ReleaseError(`APK package name is '${packageName}', expected '${PACKAGE_NAME}'.`)
  }
  if (versionName !== version) {
    throw new ReleaseError(`APK versionName is '${versionName}', expected '${version}'.`)
  }
  return { packageName, versionName, signer, certificateSha256 }
}

function hashFile(file) {
  const descriptor = openSync(file, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let bytes
    while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes))
    }
  } finally {
    closeSync(descriptor)
  }
  return hash.digest('hex')
}

function archiveApk(root, apk, version) {
  const directory = join(root, 'dist')
  mkdirSync(directory, { recursive: true })
  const target = join(directory, `QQPet-${version}.apk`)
  // Copy and hash a temporary sibling first, then rename atomically so an
  // interrupted run can never leave a half-written APK or clobber the previous
  // successful artifact.
  const temporary = join(directory, `.QQPet-${version}.apk.tmp-${process.pid}`)
  try {
    copyFileSync(apk, temporary)
    const sha256 = hashFile(temporary)
    renameSync(temporary, target)
    return { apk: target, sha256 }
  } finally {
    try {
      if (existsSync(temporary)) unlinkSync(temporary)
    } catch {
      // The temporary file is best-effort cleanup; the rename above is what counts.
    }
  }
}

/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */

export function runReleaseAndroid(options = {}, deps = {}) {
  const root = deps.root ?? options.root ?? REPOSITORY_ROOT
  const platform = deps.platform ?? process.platform
  const home = deps.homedir ?? osHomedir()
  const run = deps.run ?? defaultRun
  const log = deps.log ?? defaultLog
  const json = options.json === true
  const stdio = json ? 'stderr' : 'inherit'

  const resolved = resolveReleaseEnv({
    env: deps.env ?? process.env,
    envFile: options.envFile ?? null,
    noEnvFile: options.noEnvFile === true,
    homedir: home,
  })
  const env = resolved.env
  if (resolved.path) log(`release: env file ${resolved.path} (existing environment wins)`)

  const version = readPackageVersion(root)
  log(`release: android ${version}`)

  const java = resolveJava(run, env, platform)
  log(`release: Java ${java.version} (${java.home}, ${java.source})`)

  const sdk = resolveAndroidSdk({ sdkCandidates: deps.sdkCandidates }, env, home)
  log(`release: Android SDK ${sdk.sdk} (build-tools ${sdk.buildTools.version})`)

  const signing = resolveSigning(root, env)
  log(`release: signing via ${signing.source}`)

  resolveGradleWrapper(root)
  const localProperties = ensureLocalProperties(root, sdk.sdk)
  log(`release: android/local.properties ${localProperties.created ? 'created' : 'kept'} (${localProperties.path})`)

  const buildEnv = {
    ...env,
    JAVA_HOME: java.home,
    ANDROID_HOME: sdk.sdk,
    ANDROID_SDK_ROOT: sdk.sdk,
    PATH: [join(java.home, 'bin'), join(sdk.sdk, 'platform-tools'), env.PATH].filter(Boolean).join(delimiter),
  }
  const step = (label, command, args, stepOptions) => {
    log(`release: ${label}`)
    const result = run(command, args, stepOptions)
    if (result.status !== 0) {
      throw new ReleaseError(`${label} failed with exit code ${result.status ?? 'unknown'}.`)
    }
    return result
  }

  step('npm run typecheck', 'npm', ['run', 'typecheck'], { cwd: root, env, stdio })
  step('npm run build:android-web', 'npm', ['run', 'build:android-web'], {
    cwd: root,
    env: { ...env, QQPET_VERSION: version },
    stdio,
  })
  step('./gradlew assembleRelease', './gradlew', ['assembleRelease'], {
    cwd: join(root, 'android'),
    env: buildEnv,
    stdio,
  })

  log('release: verifying signature and package metadata')
  const verified = verifyApk(run, sdk.buildTools, join(root, RELEASE_APK), version, buildEnv)
  const archived = archiveApk(root, join(root, RELEASE_APK), version)
  log(`release: archived ${archived.apk}`)
  log(`release: sha256 ${archived.sha256}`)

  return {
    ok: true,
    target: TARGET,
    version,
    apk: archived.apk,
    sha256: archived.sha256,
    packageName: verified.packageName,
    versionName: verified.versionName,
    signer: verified.signer,
    certificateSha256: verified.certificateSha256,
  }
}

export function formatSummary(summary) {
  return [
    `release: android ${summary.version}`,
    `package: ${summary.packageName}`,
    `versionName: ${summary.versionName}`,
    `signer: ${summary.signer ?? '(unavailable)'}`,
    `certificateSha256: ${summary.certificateSha256 ?? '(unavailable)'}`,
    `apk: ${summary.apk}`,
    `sha256: ${summary.sha256}`,
  ].join('\n')
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * CLI entry used by scripts/build-android-release.mjs and by the tests.
 * Returns the process exit code instead of calling process.exit so it stays testable.
 */
export function main(argv = process.argv.slice(2), deps = createDefaultDeps()) {
  const jsonRequested = argv.includes('--json')
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    const message = messageOf(error)
    if (jsonRequested) deps.print(JSON.stringify({ ok: false, error: message }))
    else deps.log(`error: ${message}\n\n${usage()}`)
    return 1
  }

  if (options.help) {
    deps.print(usage())
    return 0
  }

  try {
    const summary = runReleaseAndroid(options, deps)
    if (options.json) deps.print(JSON.stringify(summary))
    else deps.print(formatSummary(summary))
    return 0
  } catch (error) {
    const message = messageOf(error)
    deps.log(`error: ${message}`)
    if (options.json) deps.print(JSON.stringify({ ok: false, error: message }))
    return 1
  }
}

function defaultLog(line) {
  process.stderr.write(`${line}\n`)
}

function defaultPrint(line) {
  process.stdout.write(`${line}\n`)
}

function defaultRun(command, args, options = {}) {
  const stdio =
    options.stdio === 'inherit'
      ? 'inherit'
      : options.stdio === 'stderr'
        ? ['ignore', 2, 2]
        : ['ignore', 'pipe', 'pipe']
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio,
    encoding: 'utf8',
  })
  if (result.error) throw new ReleaseError(`Failed to start ${command}: ${result.error.message}`)
  return {
    status: result.status ?? 1,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

export function createDefaultDeps(overrides = {}) {
  return {
    root: REPOSITORY_ROOT,
    env: process.env,
    platform: process.platform,
    homedir: osHomedir(),
    run: defaultRun,
    log: defaultLog,
    print: defaultPrint,
    ...overrides,
  }
}

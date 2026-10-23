/**
 * Compose configuration smoke.
 *
 * Proves the checked-in Compose file renders with an explicit 0600 owner
 * credential, mounts it as a Compose secret rather than a runtime-host bind,
 * and rejects an unset/empty or missing credential file. The Docker smoke then
 * proves the runtime uid can actually read the staged secret.
 */
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const COMPOSE_FILE = join(ROOT, 'server/docker-compose.yml')

function probe(command, args) {
  return spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function resolveCompose() {
  const forced = process.env.QQPET_COMPOSE_COMMAND?.trim()
  if (forced) return { command: forced, prefix: [] }
  const plugin = probe('docker', ['compose', 'version'])
  if (plugin.status === 0) return { command: 'docker', prefix: ['compose'] }
  const standalone = probe('docker-compose', ['version'])
  if (standalone.status === 0) return { command: 'docker-compose', prefix: [] }
  throw new Error('neither `docker compose` nor `docker-compose` is available')
}

async function assertCredentialFile(path) {
  const info = await stat(path)
  if (info.isFile() === false) throw new Error('owner credential path is not a regular file')
  if ((info.mode & 0o077) !== 0) throw new Error('owner credential file must not be group/world accessible')
}

function runConfig(compose, envFile, credentialFile, env) {
  const args = [
    ...compose.prefix,
    '--env-file', envFile,
    '-f', COMPOSE_FILE,
    'config',
  ]
  const childEnv = { ...process.env, ...env }
  if (credentialFile === null) delete childEnv.QQPET_OWNER_ADMIN_CREDENTIAL_FILE
  else childEnv.QQPET_OWNER_ADMIN_CREDENTIAL_FILE = credentialFile
  return spawnSync(compose.command, args, {
    cwd: ROOT,
    env: childEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  })
}

async function main() {
  const compose = resolveCompose()
  const root = await mkdtemp(join(tmpdir(), 'qqpet-compose-smoke-'))
  const credentialFile = join(root, 'owner-admin-credential')
  const missingFile = join(root, 'missing-owner-admin-credential')
  const emptyEnvFile = join(root, 'empty.env')
  try {
    await writeFile(credentialFile, 'compose-smoke-' + 'a'.repeat(64) + '\n', { mode: 0o600 })
    await writeFile(emptyEnvFile, '')
    await assertCredentialFile(credentialFile)

    const valid = runConfig(compose, emptyEnvFile, credentialFile)
    if (valid.status === 0) {
      // expected
    } else {
      throw new Error('Compose config failed with required env set:\n' + (valid.stderr || valid.stdout))
    }
    if (valid.stdout.includes('owner_admin_credential.example')) {
      throw new Error('Compose config still references the removed checked-in placeholder credential')
    }
    for (const required of [
      'QQPET_OWNER_ADMIN_CREDENTIAL: /run/qqpet-secrets/owner_admin_credential',
      'QQPET_OWNER_ADMIN_CREDENTIAL_SOURCE: /run/secrets/owner_admin_credential',
      '/usr/local/bin/qqpet-docker-entrypoint.sh',
    ]) {
      if (valid.stdout.includes(required) === false) {
        throw new Error('Compose config is missing required secret staging setting: ' + required)
      }
    }
    if (/^secrets:\s*$/m.test(valid.stdout) === false
      || /^\s{2}owner_admin_credential:\s*$/m.test(valid.stdout) === false) {
      throw new Error('Compose config does not declare the owner credential as a top-level secret')
    }
    if (valid.stdout.includes('source: ' + credentialFile)) {
      throw new Error('Compose config still bind-mounts the host credential file directly')
    }

    const unset = runConfig(compose, emptyEnvFile, null)
    if (unset.status === 0) throw new Error('Compose config unexpectedly succeeded without the required credential variable')

    const missing = runConfig(compose, emptyEnvFile, missingFile)
    if (missing.status === 0) throw new Error('Compose config unexpectedly succeeded with a missing credential file')
    let missingFileCreated = false
    try {
      await stat(missingFile)
      missingFileCreated = true
    } catch {
      missingFileCreated = false
    }
    if (missingFileCreated) throw new Error('Compose created a host path for the missing credential file')

    process.stdout.write('C12_COMPOSE_SMOKE_RESULT ' + JSON.stringify({
      result: 'PASS',
      command: [compose.command, ...compose.prefix].join(' '),
      validConfig: true,
      composeSecretMounted: true,
      hostCredentialNotDirectlyBindMounted: true,
      containerStagingEntrypoint: true,
      unsetVariableRejected: true,
      missingFileRejectedByCompose: true,
    }) + '\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

main().catch(error => {
  process.stderr.write('[compose-smoke] FAILED: ' + (error instanceof Error ? error.stack ?? error.message : String(error)) + '\n')
  process.exitCode = 1
})

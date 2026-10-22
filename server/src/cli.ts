import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, link, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import WebSocket from 'ws'
import { PROTOCOL_VERSION, type ServerToClient } from '../../src/shared/sync/index'
import { createServerConfig, type ServerConfig } from './config'
import { initializePet, inspectRestoreSource, openDatabase, openDatabaseReadOnly, readRestoreGenerationRecord } from './db'
import { createBackupPath, SyncServer } from './index'

interface ParsedArgs {
  command: string
  positional: string[]
  flags: Map<string, string | true>
}

function parseArgs(args: string[]): ParsedArgs {
  const command = args[0] ?? ''
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  for (let index = 1; index < args.length; index++) {
    const item = args[index]
    if (!item.startsWith('--')) {
      positional.push(item)
      continue
    }
    const name = item.slice(2)
    const next = args[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next)
      index++
    } else {
      flags.set(name, true)
    }
  }
  return { command, positional, flags }
}

function stringFlag(args: ParsedArgs, name: string, required = false): string | undefined {
  const value = args.flags.get(name)
  if (value === true) throw new Error('--' + name + ' requires a value')
  if (value === undefined && required) throw new Error('--' + name + ' is required')
  return value
}

function configFrom(args: ParsedArgs): ServerConfig {
  return createServerConfig({
    dbPath: stringFlag(args, 'db'),
    bind: stringFlag(args, 'bind'),
    port: stringFlag(args, 'port') === undefined ? undefined : Number(stringFlag(args, 'port')),
  })
}

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncDirectoryBestEffort(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Directory fsync is a durability enhancement, not a restore precondition.
  }
}

async function removeDatabaseSidecars(path: string): Promise<void> {
  await rm(path + '-wal', { force: true })
  await rm(path + '-shm', { force: true })
}

async function removeDatabaseFilesBestEffort(path: string): Promise<void> {
  try {
    await rm(path, { force: true })
    await removeDatabaseSidecars(path)
  } catch {
    // Best-effort cleanup must not hide the original restore result.
  }
}

async function readLiveRestoreGeneration(path: string): Promise<number | undefined> {
  if (await isRegularFile(path) === false) return undefined
  try {
    const store = openDatabaseReadOnly(path)
    try {
      return store.maxRestoreGeneration()
    } finally {
      store.close()
    }
  } catch {
    // An explicit restore is also the recovery path for a corrupt live DB.
    return undefined
  }
}

async function assertLiveDatabaseStopped(path: string): Promise<void> {
  try {
    const info = await stat(path + '-wal')
    if (info.size > 0) {
      throw new Error('live database has pending WAL data; stop the server and retry restore')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

async function installStagedDatabase(stagedPath: string, livePath: string, previousPath: string): Promise<boolean> {
  const hadLive = await isRegularFile(livePath)
  await assertLiveDatabaseStopped(livePath)
  await rm(previousPath, { force: true })
  await removeDatabaseSidecars(previousPath)
  if (hadLive) {
    try {
      await link(livePath, previousPath)
    } catch {
      await rm(previousPath, { force: true })
      await copyFile(livePath, previousPath, constants.COPYFILE_EXCL)
    }
    await syncFile(previousPath)
    await syncDirectoryBestEffort(dirname(livePath))
  }
  await removeDatabaseSidecars(livePath)
  await rename(stagedPath, livePath)
  await syncDirectoryBestEffort(dirname(livePath))
  return hadLive
}

async function rollbackInstalledDatabase(livePath: string, previousPath: string, hadLive: boolean): Promise<void> {
  if (hadLive) {
    await rename(previousPath, livePath)
  } else {
    await rm(livePath, { force: true })
  }
  await removeDatabaseSidecars(livePath)
  await syncDirectoryBestEffort(dirname(livePath))
}

async function writeRestoreGeneration(path: string, generation: number): Promise<void> {
  const temporaryPath = path + '.restore-' + process.pid + '-' + randomUUID() + '.tmp'
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temporaryPath, String(generation) + '\n', { mode: 0o600 })
    await syncFile(temporaryPath)
    await rename(temporaryPath, path)
    await syncDirectoryBestEffort(dirname(path))
  } finally {
    try {
      await rm(temporaryPath, { force: true })
    } catch {
      // A cleanup failure after the atomic rename must not report restore failure.
    }
  }
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const values = new Set(left)
  for (const value of right) {
    if (values.has(value) === false) return false
  }
  return true
}

function requireRestoreCondition(condition: boolean, message: string): void {
  if (condition === false) throw new Error(message)
}

async function init(args: ParsedArgs): Promise<void> {
  const config = configFrom(args)
  await mkdir(dirname(config.dbPath), { recursive: true })
  const store = openDatabase(config.dbPath)
  try {
    const result = initializePet(store, {
      petId: stringFlag(args, 'pet-id') ?? 'default',
      timeZone: stringFlag(args, 'time-zone') ?? config.timeZone,
      weatherCity: stringFlag(args, 'weather-city') ?? config.weatherLocation,
      advanceWhileEmpty: config.advanceWhileEmpty,
    })
    print({
      ok: true,
      petId: result.petId,
      pairingCode: result.pairingCode,
      pairingExpiresAtMs: result.pairingExpiresAtMs,
      authority: result.authority,
    })
  } finally {
    store.close()
  }
}

function pair(args: ParsedArgs): void {
  const config = configFrom(args)
  const petId = stringFlag(args, 'pet-id') ?? 'default'
  const role = stringFlag(args, 'role') ?? 'player'
  if (role !== 'owner' && role !== 'player') throw new Error('--role must be owner or player')
  const store = openDatabase(config.dbPath)
  try {
    if (store.getPet(petId) === undefined) throw new Error('pet not found: ' + petId)
    const result = store.issuePairingCode(petId, role, config.pairingTtlMs)
    print({ ok: true, petId, role, pairingCode: result.code, expiresAtMs: result.expiresAtMs })
  } finally {
    store.close()
  }
}

async function backup(args: ParsedArgs): Promise<void> {
  const config = configFrom(args)
  const petId = stringFlag(args, 'pet-id') ?? 'default'
  const server = new SyncServer(config, openDatabase(config.dbPath))
  try {
    const path = stringFlag(args, 'output') ?? createBackupPath(config, petId)
    await server.backup(path)
    print({ ok: true, petId, path })
  } finally {
    await server.stop()
  }
}

async function status(args: ParsedArgs): Promise<void> {
  const config = configFrom(args)
  const store = openDatabase(config.dbPath)
  try {
    print({
      ok: true,
      dbPath: config.dbPath,
      pets: store.listPets().map(pet => ({
        petId: pet.id,
        revision: pet.revision,
        eventSeq: pet.eventSeq,
        gameTimeMs: pet.gameTimeMs,
        settings: store.getSettings(pet.id),
        authority: store.getAuthority(pet.id),
      })),
    })
  } finally {
    store.close()
  }
}

function offlineRevoke(args: ParsedArgs): void {
  const config = configFrom(args)
  const petId = stringFlag(args, 'pet-id', true)
  const deviceId = stringFlag(args, 'device-id', true)
  const store = openDatabase(config.dbPath)
  try {
    if (petId === undefined || deviceId === undefined) throw new Error('pet and device ids are required')
    const revokedAtMs = store.revokeDevice(petId, deviceId)
    if (revokedAtMs === undefined) throw new Error('device not found')
    print({ ok: true, petId, deviceId, revokedAtMs, offline: true })
  } finally {
    store.close()
  }
}

async function restore(args: ParsedArgs): Promise<void> {
  const config = configFrom(args)
  const from = stringFlag(args, 'from', true)
  if (from === undefined) throw new Error('--from is required')
  requireRestoreCondition(args.flags.get('accept-rollback') === true, '--accept-rollback is required')
  const credentialPath = stringFlag(args, 'owner-admin-credential') ?? config.ownerAdminCredential
  if (credentialPath === undefined) throw new Error('--owner-admin-credential is required')
  const credential = (await readFile(credentialPath, 'utf8')).trim()
  if (credential.length === 0) throw new Error('owner credential file is empty')
  const requestedRaw = stringFlag(args, 'restore-generation')
  const requested = requestedRaw === undefined ? undefined : Number(requestedRaw)
  if (requested !== undefined && (Number.isSafeInteger(requested) === false || requested < 0)) {
    throw new Error('--restore-generation must be a non-negative integer')
  }

  let sourceStat
  try {
    sourceStat = await stat(from)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('backup file does not exist: ' + from)
    throw error
  }
  if (sourceStat.isFile() === false) throw new Error('backup is not a regular file: ' + from)

  // Validate the entire candidate and its generation fence before the live DB
  // is opened for writing or replaced.
  const source = inspectRestoreSource(from)
  const recorded = readRestoreGenerationRecord(config.restoreGenerationFile)
  const liveGeneration = await readLiveRestoreGeneration(config.dbPath)
  const currentGeneration = Math.max(source.maxRestoreGeneration, recorded ?? 0, liveGeneration ?? 0)
  if (Number.isSafeInteger(currentGeneration) === false || currentGeneration < 0) {
    throw new Error('restore generation is invalid')
  }
  let nextGeneration: number
  if (requested === undefined) {
    if (currentGeneration === Number.MAX_SAFE_INTEGER) throw new Error('restore generation cannot advance')
    nextGeneration = currentGeneration + 1
  } else {
    if (requested <= currentGeneration) {
      throw new Error('--restore-generation must advance beyond the current/recorded generation')
    }
    nextGeneration = requested
  }
  if (Number.isSafeInteger(nextGeneration) === false || nextGeneration < 0) {
    throw new Error('restore generation is invalid')
  }

  const previousPath = config.dbPath + '.restore-previous'
  let stagedPath: string | undefined
  let installed = false
  let committed = false
  let hadLive = false
  try {
    await mkdir(dirname(config.dbPath), { recursive: true })
    const stagedName = '.' + basename(config.dbPath) + '.restore-' + process.pid + '-' + randomUUID() + '.tmp'
    stagedPath = join(dirname(config.dbPath), stagedName)
    await copyFile(from, stagedPath, constants.COPYFILE_EXCL)

    // Reset authority only in the staged copy. A failure here cannot alter the
    // live database, and the reset is committed in one staging transaction.
    const staged = openDatabase(stagedPath)
    try {
      for (const petId of source.petIds) staged.loadCanonical(petId)
      staged.resetAuthoritiesAfterRestore(source.petIds, nextGeneration)
    } finally {
      staged.close()
    }

    // Re-open and verify the staged result before it can become live.
    const verified = inspectRestoreSource(stagedPath)
    requireRestoreCondition(sameStringSet(verified.petIds, source.petIds), 'restored pet set changed unexpectedly')
    requireRestoreCondition(verified.maxRestoreGeneration === nextGeneration, 'staged restore generation was not applied')
    const verifiedAuthorities = new Map(verified.authorities.map(authority => [authority.petId, authority]))
    requireRestoreCondition(verifiedAuthorities.size === source.authorities.length, 'staged restore authority set is incomplete')
    for (const original of source.authorities) {
      const restored = verifiedAuthorities.get(original.petId)
      if (restored === undefined) throw new Error('staged restore authority is missing: ' + original.petId)
      requireRestoreCondition(restored.restoreGeneration === nextGeneration, 'staged restore generation was not applied: ' + original.petId)
      requireRestoreCondition((restored.authorityId === original.authorityId) === false, 'staged restore did not rotate authority: ' + original.petId)
      requireRestoreCondition(restored.epoch === original.epoch + 1, 'staged restore did not advance authority epoch: ' + original.petId)
      requireRestoreCondition(
        restored.state === 'active' && restored.owner === 'server',
        'staged restore authority is not active on the server: ' + original.petId,
      )
    }

    await syncFile(stagedPath)
    hadLive = await isRegularFile(config.dbPath)
    await installStagedDatabase(stagedPath, config.dbPath, previousPath)
    installed = true

    // The live DB now points at the verified staged file. Publish the external
    // generation fence last; if that fails, roll the previous DB back below.
    if (config.restoreGenerationFile !== undefined) {
      await writeRestoreGeneration(config.restoreGenerationFile, nextGeneration)
    }
    committed = true
    print({
      ok: true,
      restoredFrom: from,
      pets: verified.petIds,
      restoreGeneration: nextGeneration,
      authority: verified.authorities.map(authority => ({
        petId: authority.petId,
        authorityId: authority.authorityId,
        epoch: authority.epoch,
        state: authority.state,
      })),
    })
  } catch (error) {
    if (installed && committed === false) {
      try {
        await rollbackInstalledDatabase(config.dbPath, previousPath, hadLive)
      } catch (rollbackError) {
        const originalMessage = error instanceof Error ? error.message : String(error)
        const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        throw new Error('restore failed and rollback failed: ' + rollbackMessage + '; original error: ' + originalMessage)
      }
    }
    throw error
  } finally {
    if (stagedPath !== undefined) await removeDatabaseFilesBestEffort(stagedPath)
  }
}

async function controlRevoke(args: ParsedArgs): Promise<void> {
  const config = configFrom(args)
  const petId = stringFlag(args, 'pet-id') ?? 'default'
  const deviceId = args.positional[0] ?? stringFlag(args, 'device-id', true)
  const credentialPath = stringFlag(args, 'owner-admin-credential') ?? config.ownerAdminCredential
  if (credentialPath === undefined) throw new Error('--owner-admin-credential is required')
  const credential = (await readFile(credentialPath, 'utf8')).trim()
  if (credential.length === 0) throw new Error('owner credential file is empty')
  const socket = new WebSocket('ws://' + config.bind + ':' + config.port + '/v1/sync')
  const messages: ServerToClient[] = []
  socket.on('message', data => messages.push(JSON.parse(data.toString()) as ServerToClient))
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  socket.send(JSON.stringify({
    t: 'hello',
    v: PROTOCOL_VERSION,
    requestId: 'admin-hello',
    petId,
    deviceId: args.flags.get('owner-device-id') === true ? undefined : stringFlag(args, 'owner-device-id'),
    appVersion: 'qqpet-server-cli',
    auth: { kind: 'token', token: credential },
  }))
  await waitForMessage(messages, 'ready')
  socket.send(JSON.stringify({
    t: 'command',
    v: PROTOCOL_VERSION,
    requestId: 'admin-revoke',
    opId: 'admin-revoke-' + deviceId,
    command: { type: 'device.revoke', payload: { deviceId } },
  }))
  const result = await waitForMessage(messages, 'commandResult')
  print(result)
  socket.close(1000, 'done')
}

async function waitForMessage(messages: ServerToClient[], type: ServerToClient['t']): Promise<ServerToClient> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const found = messages.find(message => message.t === type)
    if (found !== undefined) return found
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting for ' + type)
}

export async function runCli(args: string[]): Promise<void> {
  const parsed = parseArgs(args)
  switch (parsed.command) {
    case 'init':
      await init(parsed)
      return
    case 'pair':
      pair(parsed)
      return
    case 'backup':
      await backup(parsed)
      return
    case 'restore':
      await restore(parsed)
      return
    case 'status':
      await status(parsed)
      return
    case 'revoke-device':
      if (parsed.flags.get('offline') === true) offlineRevoke(parsed)
      else await controlRevoke(parsed)
      return
    case 'ctl':
      if (parsed.positional[0] === 'revoke-device') {
        await controlRevoke({ ...parsed, positional: parsed.positional.slice(1) })
        return
      }
      throw new Error('unknown ctl subcommand')
    default:
      throw new Error('usage: qqpet-server <start|init|pair|backup|restore|status|ctl|revoke-device>')
  }
}

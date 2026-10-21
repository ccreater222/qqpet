import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import WebSocket from 'ws'
import { PROTOCOL_VERSION, type ServerToClient } from '../../src/shared/sync/index'
import { createServerConfig, type ServerConfig } from './config'
import { initializePet, openDatabase } from './db'
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
  if (args.flags.get('accept-rollback') !== true) throw new Error('--accept-rollback is required')
  const credentialPath = stringFlag(args, 'owner-admin-credential', true)
  if (credentialPath === undefined) throw new Error('--owner-admin-credential is required')
  const credential = (await readFile(credentialPath, 'utf8')).trim()
  if (credential.length === 0) throw new Error('owner credential file is empty')
  const requestedRaw = stringFlag(args, 'restore-generation')
  const requested = requestedRaw === undefined ? undefined : Number(requestedRaw)
  if (requested !== undefined && (Number.isSafeInteger(requested) === false || requested < 0)) {
    throw new Error('--restore-generation must be a non-negative integer')
  }
  // Verify the backup before replacing the live database.
  const backup = openDatabase(from)
  let pets: string[]
  try {
    pets = backup.listPets().map(pet => pet.id)
    if (pets.length === 0) throw new Error('backup contains no pets')
  } finally {
    backup.close()
  }
  await mkdir(dirname(config.dbPath), { recursive: true })
  await copyFile(from, config.dbPath)
  const store = openDatabase(config.dbPath)
  try {
    const recorded = store.verifyRestoreGeneration(config.restoreGenerationFile)
    const current = store.maxRestoreGeneration()
    const nextGeneration = Math.max(current + 1, recorded + 1, requested ?? 0)
    if (requested !== undefined && requested < current + 1 && requested < recorded + 1) {
      throw new Error('--restore-generation must advance beyond the current/recorded generation')
    }
    const authorities = pets.map(petId => store.resetAuthorityAfterRestore(petId, nextGeneration))
    if (config.restoreGenerationFile !== undefined) {
      await mkdir(dirname(config.restoreGenerationFile), { recursive: true })
      await writeFile(config.restoreGenerationFile, String(nextGeneration) + '\n', { mode: 0o600 })
    }
    print({
      ok: true,
      restoredFrom: from,
      pets,
      restoreGeneration: nextGeneration,
      authority: authorities.map(authority => ({
        petId: authority.petId,
        authorityId: authority.authorityId,
        epoch: authority.epoch,
        state: authority.state,
      })),
    })
  } finally {
    store.close()
  }
}

async function controlRevoke(args: ParsedArgs): Promise<void> {
  const config = configFrom(args)
  const petId = stringFlag(args, 'pet-id') ?? 'default'
  const deviceId = args.positional[0] ?? stringFlag(args, 'device-id', true)
  const credentialPath = stringFlag(args, 'owner-admin-credential', true)
  if (credentialPath === undefined) throw new Error('--owner-admin-credential is required')
  const credential = (await readFile(credentialPath, 'utf8')).trim()
  if (credential.length === 0) throw new Error('owner credential file is empty')
  const socket = new WebSocket('ws://' + config.bind + ':' + config.port + '/sync')
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

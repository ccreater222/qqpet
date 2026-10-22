import type WebSocket from 'ws'
import {
  PROTOCOL_VERSION,
  type DeviceRole,
  type OrderedEvent,
  type ServerToClient,
  type WireCommandResult,
} from '../../src/shared/sync/index'
import type { DatabaseStore, PetRecord } from './db'
import type { Logger } from './logging'
import { assertPublicEvent, assertPublicSave } from './validation'

export interface LiveConnection {
  socket: WebSocket
  connectionId: string
  petId: string
  deviceId: string
  role: DeviceRole
  coverageId: string
  authenticated: boolean
  alive: boolean
  lastActivityMs: number
}

export class SocketHub {
  private readonly pets = new Map<string, Set<LiveConnection>>()
  private readonly coverage = new Map<string, string>()

  constructor(
    private readonly store: DatabaseStore,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
    private readonly maxFrameBytes: number = 16 * 1024 * 1024,
  ) {}

  add(connection: LiveConnection): void {
    let set = this.pets.get(connection.petId)
    if (set === undefined) {
      set = new Set()
      this.pets.set(connection.petId, set)
    }
    set.add(connection)
    this.coverage.set(connection.connectionId, connection.coverageId)
  }

  remove(connection: LiveConnection, reason: 'disconnect' | 'shutdown' | 'socket_closed' = 'socket_closed'): void {
    this.pets.get(connection.petId)?.delete(connection)
    if (this.pets.get(connection.petId)?.size === 0) this.pets.delete(connection.petId)
    this.coverage.delete(connection.connectionId)
    try {
      this.store.closeCoverage(connection.petId, connection.coverageId, this.now(), reason)
    } catch (error) {
      this.logger.warn('coverage.close_failed', { petId: connection.petId, error })
    }
  }

  count(petId: string): number {
    return this.pets.get(petId)?.size ?? 0
  }

  send(connection: LiveConnection, message: ServerToClient): void {
    if (connection.socket.readyState !== connection.socket.OPEN) return
    const text = JSON.stringify(message)
    if (Buffer.byteLength(text) > this.maxFrameBytes) {
      this.logger.warn('socket.frame_too_large', { connectionId: connection.connectionId, bytes: Buffer.byteLength(text) })
      connection.socket.close(4005, 'payload_too_large')
      return
    }
    connection.socket.send(text)
  }

  broadcast(petId: string, message: ServerToClient, except?: LiveConnection): void {
    for (const connection of this.pets.get(petId) ?? []) {
      if (connection !== except) this.send(connection, message)
    }
  }

  broadcastProjection(petId: string, pet: PetRecord, events: OrderedEvent[]): void {
    const authority = this.authority(petId)
    const settings = this.store.getSettings(petId)
    const snapshot = this.store.loadCanonical(petId)
    try {
      assertPublicSave(snapshot.engine.save)
      for (const event of events) assertPublicEvent(event)
    } catch (error) {
      this.logger.error('projection.boundary_rejected', { petId, error })
      return
    }
    const message = {
      t: 'projection' as const,
      v: PROTOCOL_VERSION,
      revision: pet.revision,
      eventSeq: pet.eventSeq,
      gameTimeMs: pet.gameTimeMs,
      timeZone: settings?.timeZone ?? snapshot.engine.timeZone,
      advanceWhileEmpty: settings?.advanceWhileEmpty ?? snapshot.engine.advanceWhileEmpty,
      weatherLocation: settings?.weatherLocation ?? snapshot.engine.weatherLocation ?? '',
      authority,
      save: snapshot.engine.save,
      events,
    }
    this.broadcast(petId, message)
  }

  sendResult(connection: LiveConnection, result: WireCommandResult): void {
    this.send(connection, result)
  }

  broadcastRevoked(petId: string, deviceId: string, revokedAtMs: number): void {
    this.broadcast(petId, {
      t: 'deviceRevoked',
      v: PROTOCOL_VERSION,
      deviceId,
      revokedAtMs,
    })
  }

  revokeDevice(petId: string, deviceId: string): void {
    const victims = [...(this.pets.get(petId) ?? [])].filter(connection => connection.deviceId === deviceId)
    for (const victim of victims) {
      this.remove(victim, 'disconnect')
      victim.socket.close(4002, 'revoked')
    }
  }

  /** Clear a pet's live registry and close every attached socket after a handoff. */
  closePet(petId: string, closeReason = 'authority_archived'): number {
    const connections = [...(this.pets.get(petId) ?? [])]
    for (const connection of connections) {
      this.remove(connection, 'socket_closed')
      connection.socket.close(1000, closeReason)
    }
    return connections.length
  }

  closeAll(reason: 'shutdown' | 'socket_closed' = 'shutdown'): void {
    for (const set of this.pets.values()) {
      for (const connection of [...set]) {
        this.remove(connection, reason)
        connection.socket.close(1001, 'server stopping')
      }
    }
  }

  listConnections(petId: string): LiveConnection[] {
    return [...(this.pets.get(petId) ?? [])]
  }

  authority(petId: string): {
    owner: 'server' | 'local'
    authorityId: string
    restoreGeneration: number
    epoch: number
    state: 'active' | 'archived' | 'reset'
  } {
    const authority = this.store.getAuthority(petId)
    if (authority === undefined) throw new Error('pet authority is missing')
    return {
      owner: authority.owner,
      authorityId: authority.authorityId,
      restoreGeneration: authority.restoreGeneration,
      epoch: authority.epoch,
      state: authority.state,
    }
  }
}

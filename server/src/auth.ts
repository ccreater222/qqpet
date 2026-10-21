import type { ClientHello } from '../../src/shared/sync/index'
import type { DatabaseStore, DeviceRecord } from './db'

export interface AuthenticatedDevice {
  petId: string
  device: DeviceRecord
  issuedToken?: string
}

export class AuthenticationError extends Error {}

/** Authentication failed because the presented device token was revoked. */
export class RevokedDeviceError extends AuthenticationError {}

export class AuthService {
  constructor(
    private readonly store: DatabaseStore,
    private readonly now: () => number = Date.now,
  ) {}

  identify(hello: ClientHello): { petId: string; device?: DeviceRecord } {
    if (hello.auth.kind === 'token') {
      const device = this.store.getDeviceByTokenGlobal(hello.auth.token)
      if (device !== undefined && device.revokedAtMs !== null) {
        throw new RevokedDeviceError('device was revoked')
      }
      if (device === undefined || hello.petId !== undefined && hello.petId !== device.petId) {
        throw new AuthenticationError('authentication failed')
      }
      if (hello.deviceId !== undefined && hello.deviceId !== device.deviceId) throw new AuthenticationError('authentication failed')
      return { petId: device.petId, device }
    }
    const pairing = this.store.getMigration(hello.auth.code)
    const at = this.now()
    if (pairing === undefined || pairing.usedAtMs !== null || pairing.expiresAtMs <= at) {
      throw new AuthenticationError('authentication failed')
    }
    if (hello.petId !== undefined && hello.petId !== pairing.petId) throw new AuthenticationError('authentication failed')
    if (hello.deviceId !== undefined) throw new AuthenticationError('authentication failed')
    return { petId: pairing.petId }
  }

  authenticate(hello: ClientHello): AuthenticatedDevice {
    const identified = this.identify(hello)
    if (identified.device !== undefined) {
      const at = this.now()
      this.store.touchDevice(identified.petId, identified.device.deviceId, at)
      return { petId: identified.petId, device: identified.device }
    }
    if (hello.auth.kind !== 'pairing') throw new AuthenticationError('authentication failed')
    const pairingAuth = hello.auth
    return this.store.transaction(() => {
      const at = this.now()
      const consumed = this.store.consumePairingCode(pairingAuth.code, at)
      if (consumed === undefined) throw new AuthenticationError('authentication failed')
      const created = this.store.createDevice(consumed.petId, pairingAuth.deviceLabel, consumed.role, at)
      return { petId: consumed.petId, device: created.device, issuedToken: created.token }
    })
  }

  recheck(petId: string, deviceId: string): DeviceRecord {
    const device = this.store.getDevice(petId, deviceId)
    if (device === undefined || device.revokedAtMs !== null) throw new AuthenticationError('device was revoked')
    return device
  }
}

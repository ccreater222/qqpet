import type { LocalRepositoryHostStorage } from '../shared/local-repository/host'
import { createAtomicV2Storage, type LocalRepositoryFileReadResult } from '../shared/local-repository/storage'

export interface IOSLocalStateRPC {
  request<T>(op: string, args: Record<string, unknown>): Promise<T>
}

/** iOS RPC state bridge; QPHostController applies allow-listed names and atomic writes. */
export function iosLocalRepositoryStorage(rpc: IOSLocalStateRPC): LocalRepositoryHostStorage {
  return createAtomicV2Storage({
    kind: 'ios-save-bridge',
    atomicDocument: true,
    backup: true,
    readState: async name => rpc.request<LocalRepositoryFileReadResult>('readLocalStateFile', { name }),
    readLegacy: async () => rpc.request<LocalRepositoryFileReadResult>('readLegacySave', {}),
    writeAtomic: async (name, text) => {
      const ok = await rpc.request<boolean>('writeLocalStateFileAtomic', { name, text })
      if (ok !== true) throw new Error('iOS atomic state write failed')
    },
  })
}

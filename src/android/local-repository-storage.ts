import type { LocalRepositoryHostStorage } from '../shared/local-repository/host'
import { createAtomicV2Storage, decodeEncodedReadResult } from '../shared/local-repository/storage'

export interface AndroidAtomicStateFiles {
  /** Encoded discriminated result: {"status":"ok","text":string|null} or {"status":"error","error":string}. */
  readStateFile(name: string): string
  readLegacySave(): string
  writeAtomic(name: string, text: string): boolean
}

/** Android's generic filesDir bridge; both methods are native atomicity capabilities. */
export function androidLocalRepositoryStorage(files: AndroidAtomicStateFiles): LocalRepositoryHostStorage {
  return createAtomicV2Storage({
    kind: 'android-native-file',
    atomicDocument: true,
    backup: true,
    readState: async name => decodeEncodedReadResult(files.readStateFile(name)),
    readLegacy: async () => decodeEncodedReadResult(files.readLegacySave()),
    writeAtomic: async (name, text) => {
      if (files.writeAtomic(name, text) !== true) throw new Error('Android atomic state write failed')
    },
  })
}

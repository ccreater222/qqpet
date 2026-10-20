import type { LocalRepositoryHostStorage } from '../shared/local-repository/host'
import { createAtomicV2Storage, decodeEncodedReadResult } from '../shared/local-repository/storage'

export interface HarmonyAtomicStateFiles {
  /** Encoded discriminated result: {"status":"ok","text":string|null} or {"status":"error","error":string}. */
  readStateFile(name: string): string
  readLegacySave(): string
  writeAtomic(name: string, text: string): boolean
}

/** Harmony ArkWeb filesDir bridge; renameSync is the atomic replacement step. */
export function harmonyLocalRepositoryStorage(files: HarmonyAtomicStateFiles): LocalRepositoryHostStorage {
  return createAtomicV2Storage({
    kind: 'harmony-native-file',
    atomicDocument: true,
    backup: true,
    readState: async name => decodeEncodedReadResult(files.readStateFile(name)),
    readLegacy: async () => decodeEncodedReadResult(files.readLegacySave()),
    writeAtomic: async (name, text) => {
      if (files.writeAtomic(name, text) !== true) throw new Error('Harmony atomic state write failed')
    },
  })
}

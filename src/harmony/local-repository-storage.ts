import type { LocalRepositoryHostStorage } from '../shared/local-repository/host'
import { createAtomicV2Storage } from '../shared/local-repository/storage'

export interface HarmonyAtomicStateFiles {
  readStateFile(name: string): string | null
  writeAtomic(name: string, text: string): boolean
}

/** Harmony ArkWeb filesDir bridge; renameSync provides the atomic replacement step. */
export function harmonyLocalRepositoryStorage(files: HarmonyAtomicStateFiles): LocalRepositoryHostStorage {
  return createAtomicV2Storage({
    kind: 'harmony-native-file',
    atomicDocument: true,
    backup: true,
    read: async name => files.readStateFile(name),
    writeAtomic: async (name, text) => {
      if (files.writeAtomic(name, text) !== true) throw new Error('Harmony atomic state write failed')
    },
  })
}

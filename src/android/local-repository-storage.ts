import type { LocalRepositoryHostStorage } from '../shared/local-repository/host'
import { createAtomicV2Storage } from '../shared/local-repository/storage'

export interface AndroidAtomicStateFiles {
  readStateFile(name: string): string | null
  writeAtomic(name: string, text: string): boolean
}

/** Android's generic filesDir bridge; both methods are native atomicity capabilities. */
export function androidLocalRepositoryStorage(files: AndroidAtomicStateFiles): LocalRepositoryHostStorage {
  return createAtomicV2Storage({
    kind: 'android-native-file',
    atomicDocument: true,
    backup: true,
    read: async name => files.readStateFile(name),
    writeAtomic: async (name, text) => {
      if (files.writeAtomic(name, text) !== true) throw new Error('Android atomic state write failed')
    },
  })
}

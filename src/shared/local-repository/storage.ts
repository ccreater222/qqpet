import type {
  LocalRepositoryHostStorage,
  LocalRepositoryHostStorageCapability,
} from './host'

export type LocalRepositoryFileHostKind =
  | 'android-native-file'
  | 'harmony-native-file'
  | 'ios-save-bridge'
  | 'mock-file'

export interface LocalRepositoryFileHost {
  readonly kind: LocalRepositoryFileHostKind
  readonly atomicDocument: boolean
  readonly backup: boolean
  /** Missing files must return null, while an existing empty file must return ''. */
  read(name: string): Promise<string | null>
  /** Must either atomically replace the whole file or reject. */
  writeAtomic(name: string, text: string): Promise<void>
}

export const LOCAL_REPOSITORY_DOCUMENT_FILE = 'save.v2.json'
export const LOCAL_REPOSITORY_DOCUMENT_BACKUP_FILE = 'save.v2.json.bak'
export const LOCAL_REPOSITORY_LEGACY_FILE = 'save.json'
export const LOCAL_REPOSITORY_LEGACY_BACKUP_FILE = 'save.json.bak'

/** Small, host-neutral adapter around the native app-private file bridges. */
export function createAtomicV2Storage(host: LocalRepositoryFileHost): LocalRepositoryHostStorage {
  let corruptSequence = 0
  const capability: LocalRepositoryHostStorageCapability = {
    kind: host.kind,
    atomicDocument: host.atomicDocument,
    backup: host.backup,
  }
  const read = async (name: string): Promise<string | null> => {
    const value = await host.read(name)
    if (value === null) return null
    if (typeof value !== 'string') throw new Error('native state read returned a non-string value')
    return value
  }
  const backupOnce = async (name: string, text: string): Promise<void> => {
    if (host.backup !== true) throw new Error('native state backup capability is unavailable')
    if (await read(name) !== null) return
    await write(name, text)
  }
  const write = async (name: string, text: string): Promise<void> => {
    if (host.atomicDocument !== true) throw new Error('native atomic state write capability is unavailable')
    await host.writeAtomic(name, text)
  }
  return {
    capability,
    readDocument: () => read(LOCAL_REPOSITORY_DOCUMENT_FILE),
    writeDocumentAtomic: text => write(LOCAL_REPOSITORY_DOCUMENT_FILE, text),
    readLegacySave: () => read(LOCAL_REPOSITORY_LEGACY_FILE),
    backupLegacySave: (_text, _reason) => backupOnce(LOCAL_REPOSITORY_LEGACY_BACKUP_FILE, _text),
    backupDocument: (_text, _reason) => backupOnce(LOCAL_REPOSITORY_DOCUMENT_BACKUP_FILE, _text),
    preserveCorruptDocument: async text => {
      let name: string
      do {
        corruptSequence += 1
        name = LOCAL_REPOSITORY_DOCUMENT_FILE + '.corrupt-' + corruptSequence
      } while (await read(name) !== null)
      await write(name, text)
    },
  }
}

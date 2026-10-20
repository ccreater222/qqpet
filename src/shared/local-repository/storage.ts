import type {
  LocalRepositoryHostStorage,
  LocalRepositoryHostStorageCapability,
} from './host'

export type LocalRepositoryFileHostKind =
  | 'android-native-file'
  | 'harmony-native-file'
  | 'ios-save-bridge'
  | 'mock-file'

export type LocalRepositoryFileReadResult =
  | { status: 'ok'; text: string | null }
  | { status: 'error'; error: string }

export interface LocalRepositoryFileHost {
  readonly kind: LocalRepositoryFileHostKind
  readonly atomicDocument: boolean
  readonly backup: boolean
  /** Missing returns ok+null; an existing empty file returns ok+''; read failure returns error. */
  readState(name: string): Promise<LocalRepositoryFileReadResult>
  /** Reads only the legacy save.json through a separate native method, never the state allowlist. */
  readLegacy(): Promise<LocalRepositoryFileReadResult>
  /** Must either atomically replace the whole file or reject. */
  writeAtomic(name: string, text: string): Promise<void>
}

export const LOCAL_REPOSITORY_DOCUMENT_FILE = 'save.v2.json'
export const LOCAL_REPOSITORY_DOCUMENT_BACKUP_FILE = 'save.v2.json.bak'
export const LOCAL_REPOSITORY_LEGACY_FILE = 'save.json'
export const LOCAL_REPOSITORY_LEGACY_BACKUP_FILE = 'save.json.bak'

/** Android/Harmony JavaScript proxies return one JSON string for a discriminated read. */
export function decodeEncodedReadResult(raw: unknown): LocalRepositoryFileReadResult {
  if (typeof raw !== 'string') return { status: 'error', error: 'native read did not return an encoded string' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return { status: 'error', error: 'native read returned invalid JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'error', error: 'native read returned an invalid result object' }
  }
  const result = parsed as Record<string, unknown>
  if (result.status === 'error' && typeof result.error === 'string') {
    return { status: 'error', error: result.error }
  }
  if (result.status === 'ok' && (result.text === null || typeof result.text === 'string')) {
    return { status: 'ok', text: result.text }
  }
  return { status: 'error', error: 'native read returned an invalid result payload' }
}

function readFailure(label: string, error: unknown): Error {
  return new Error(label + ' read failed: ' + (error instanceof Error ? error.message : String(error)))
}

/** Small, host-neutral adapter around the native app-private file bridges. */
export function createAtomicV2Storage(host: LocalRepositoryFileHost): LocalRepositoryHostStorage {
  let corruptSequence = 0
  const capability: LocalRepositoryHostStorageCapability = {
    kind: host.kind,
    atomicDocument: host.atomicDocument,
    backup: host.backup,
  }
  const checkedRead = async (
    operation: () => Promise<LocalRepositoryFileReadResult>,
    label: string,
  ): Promise<string | null> => {
    let result: LocalRepositoryFileReadResult
    try {
      result = await operation()
    } catch (error) {
      throw readFailure(label, error)
    }
    if (result === null || typeof result !== 'object') throw readFailure(label, 'native read returned no status')
    if (result.status === 'error') throw readFailure(label, result.error)
    if (result.status !== 'ok' || (result.text !== null && typeof result.text !== 'string')) {
      throw readFailure(label, 'native read returned an invalid result')
    }
    return result.text
  }
  const readState = (name: string): Promise<string | null> =>
    checkedRead(() => host.readState(name), 'local state file ' + name)
  const write = async (name: string, text: string): Promise<void> => {
    if (host.atomicDocument !== true) throw new Error('native atomic state write capability is unavailable')
    await host.writeAtomic(name, text)
  }
  const backupOnce = async (name: string, text: string): Promise<void> => {
    if (host.backup !== true) throw new Error('native state backup capability is unavailable')
    // A read error must never be mistaken for a missing backup and overwritten.
    if (await readState(name) !== null) return
    await write(name, text)
  }
  return {
    capability,
    readDocument: () => readState(LOCAL_REPOSITORY_DOCUMENT_FILE),
    writeDocumentAtomic: text => write(LOCAL_REPOSITORY_DOCUMENT_FILE, text),
    readLegacySave: () => checkedRead(() => host.readLegacy(), 'legacy save'),
    backupLegacySave: (_text, _reason) => backupOnce(LOCAL_REPOSITORY_LEGACY_BACKUP_FILE, _text),
    backupDocument: async (_text, reason) => {
      if (reason === 'import') {
        await write(LOCAL_REPOSITORY_DOCUMENT_BACKUP_FILE, _text)
        return
      }
      await backupOnce(LOCAL_REPOSITORY_DOCUMENT_BACKUP_FILE, _text)
    },
    preserveCorruptDocument: async text => {
      let name: string
      do {
        corruptSequence += 1
        name = LOCAL_REPOSITORY_DOCUMENT_FILE + '.corrupt-' + corruptSequence
      } while (await readState(name) !== null)
      await write(name, text)
    },
  }
}

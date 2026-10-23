import { DatabaseSync } from 'node:sqlite'

/**
 * A process-lifetime exclusive lock for one server database.
 *
 * SQLite keeps the OS file lock for as long as BEGIN EXCLUSIVE is open. That
 * makes the lock crash-safe (the OS releases it when the process exits) and
 * avoids stale lock files that would otherwise wedge restore forever.
 */
export class DatabaseLifetimeLock {
  private released = false

  private constructor(
    private readonly db: DatabaseSync,
    readonly path: string,
  ) {}

  static acquire(databasePath: string): DatabaseLifetimeLock {
    const lockPath = databasePath + '.server-lock.sqlite'
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(lockPath)
      db.exec('PRAGMA busy_timeout = 0')
      db.exec('BEGIN EXCLUSIVE')
      return new DatabaseLifetimeLock(db, lockPath)
    } catch (error) {
      if (db !== undefined) {
        try {
          db.close()
        } catch {
          // Preserve the acquisition error.
        }
      }
      const errcode = Number((error as { errcode?: unknown }).errcode)
      if (Number.isInteger(errcode) && (errcode & 0xff) === 5) {
        throw new Error('database is in use by a running server or another restore; stop it and retry')
      }
      throw error
    }
  }

  release(): void {
    if (this.released) return
    this.released = true
    try {
      this.db.exec('ROLLBACK')
    } catch {
      // The transaction may already have been rolled back by SQLite.
    }
    this.db.close()
  }
}

export function acquireDatabaseLifetimeLock(databasePath: string): DatabaseLifetimeLock {
  return DatabaseLifetimeLock.acquire(databasePath)
}

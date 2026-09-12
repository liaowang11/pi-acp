import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Cache of session listing metadata, keyed by the session file's path relative to the
 * sessions directory.
 *
 * Listing sessions means opening every session file pi ever wrote, so a cold scan of a
 * large store costs hundreds of MB of reads. The cache lets a listing reuse the title,
 * cwd and timestamps of unchanged files and only re-read the ones that moved.
 */
export const SESSION_INDEX_VERSION = 1

export type SessionIndexEntry = {
  /** File size in bytes. Part of the cache key together with mtimeMs. */
  size: number
  /** File mtime in ms. Part of the cache key together with size. */
  mtimeMs: number
  sessionId: string
  cwd: string
  title: string | null
  updatedAt: string | null
}

type SessionIndexFile = {
  version: number
  sessionsDir: string
  files: Record<string, SessionIndexEntry>
}

export type SessionIndex = Map<string, SessionIndexEntry>

function isEntry(value: unknown): value is SessionIndexEntry {
  const entry = value as SessionIndexEntry | null
  return (
    !!entry &&
    typeof entry === 'object' &&
    typeof entry.size === 'number' &&
    typeof entry.mtimeMs === 'number' &&
    typeof entry.sessionId === 'string' &&
    typeof entry.cwd === 'string' &&
    (entry.title === null || typeof entry.title === 'string') &&
    (entry.updatedAt === null || typeof entry.updatedAt === 'string')
  )
}

export function loadSessionIndex(path: string, sessionsDir: string): SessionIndex {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as SessionIndexFile
    if (parsed?.version !== SESSION_INDEX_VERSION) return new Map()
    // The index describes one sessions directory; a different one invalidates it.
    if (parsed.sessionsDir !== sessionsDir) return new Map()
    if (!parsed.files || typeof parsed.files !== 'object') return new Map()

    const index: SessionIndex = new Map()
    for (const [key, entry] of Object.entries(parsed.files)) {
      if (isEntry(entry)) index.set(key, entry)
    }
    return index
  } catch {
    return new Map()
  }
}

export function saveSessionIndex(path: string, sessionsDir: string, index: SessionIndex): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const data: SessionIndexFile = {
      version: SESSION_INDEX_VERSION,
      sessionsDir,
      files: Object.fromEntries(index)
    }
    // Write and rename so that a concurrent reader never sees a partial index.
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(data) + '\n', 'utf-8')
    renameSync(tmp, path)
  } catch {
    // The index is an optimization: never fail a listing because it cannot be written.
  }
}

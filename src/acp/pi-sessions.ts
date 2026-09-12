import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, isAbsolute } from 'node:path'

export type PiSessionListItem = {
  sessionId: string
  cwd: string
  title: string | null
  updatedAt: string | null
  sessionFile: string
}

const DEFAULT_TAIL_BYTES = 256 * 1024
const DEFAULT_HEAD_BYTES = 64 * 1024
// First user messages are usually a few hundred bytes, but skill injections can make
// them a single multi-hundred-KB line. Cap the fallback read instead of pulling whole
// sessions into memory.
const FALLBACK_MAX_BYTES = 512 * 1024
const FALLBACK_MAX_LINES = 2000

function getPiAgentDir(): string {
  // pi supports overriding config dir via PI_CODING_AGENT_DIR.
  // See pi README.
  return process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), '.pi', 'agent')
}

function readSessionDirFromSettings(agentDir: string): string | null {
  const settingsPath = join(agentDir, 'settings.json')
  try {
    if (!existsSync(settingsPath)) return null
    const raw = readFileSync(settingsPath, 'utf8')
    const data = JSON.parse(raw) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null

    const sessionDir = (data as Record<string, unknown>).sessionDir
    if (typeof sessionDir !== 'string' || !sessionDir.trim()) return null

    return isAbsolute(sessionDir) ? sessionDir : resolve(agentDir, sessionDir)
  } catch {
    return null
  }
}

export function getPiSessionsDir(): string {
  const agentDir = getPiAgentDir()
  return readSessionDirFromSettings(agentDir) ?? join(agentDir, 'sessions')
}

function walkJsonlFiles(dir: string, out: string[]) {
  let entries: import('node:fs').Dirent[]
  try {
    // Force string names.
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' }) as unknown as import('node:fs').Dirent[]
  } catch {
    return
  }

  for (const e of entries) {
    const name = typeof (e as any).name === 'string' ? (e as any).name : String((e as any).name)
    const p = join(dir, name)
    if (e.isDirectory()) walkJsonlFiles(p, out)
    else if (e.isFile() && name.endsWith('.jsonl')) out.push(p)
  }
}

// readSync may return fewer bytes than requested; fill the buffer so that a short read
// cannot silently truncate a header line or a tail window.
function readFully(fd: number, buf: Buffer, position: number): number {
  let total = 0
  while (total < buf.length) {
    const n = readSync(fd, buf, total, buf.length - total, position + total)
    if (n <= 0) break
    total += n
  }
  return total
}

function readHead(path: string, maxBytes: number): { text: string; truncated: boolean } | null {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(maxBytes)
    const n = readFully(fd, buf, 0)
    if (n <= 0) return null
    return { text: buf.subarray(0, n).toString('utf-8'), truncated: n === maxBytes }
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
  }
}

function readFirstLine(path: string): string | null {
  // Avoid reading the whole file.
  const head = readHead(path, DEFAULT_HEAD_BYTES)
  if (head === null) return null
  const idx = head.text.indexOf('\n')
  return (idx === -1 ? head.text : head.text.slice(0, idx)).trim()
}

function readTail(path: string, size: number, tailBytes = DEFAULT_TAIL_BYTES): string {
  const start = Math.max(0, size - tailBytes)
  const len = size - start

  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(len)
    const n = readFully(fd, buf, start)
    return buf.subarray(0, n).toString('utf-8')
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
  }
}

function parseSessionHeader(firstLine: string): { sessionId: string; cwd: string } | null {
  try {
    const obj = JSON.parse(firstLine) as any
    if (obj?.type !== 'session') return null
    const sessionId = typeof obj?.id === 'string' ? obj.id : null
    const cwd = typeof obj?.cwd === 'string' ? obj.cwd : null
    if (!sessionId || !cwd) return null
    return { sessionId, cwd }
  } catch {
    return null
  }
}

function pickTitleFromTail(tail: string): string | null {
  // Try to find the *latest* session_info entry (stores the user-provided name).
  // We scan backwards line-by-line.
  const lines = tail.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      if (obj?.type === 'session_info' && typeof obj?.name === 'string' && obj.name.trim()) {
        return obj.name.trim()
      }
    } catch {
      // ignore
    }
  }
  return null
}

function scanSessionInfoNameFromFile(path: string): string | null {
  // Fallback when the session_info entry is older than our tail window.
  // Scan the whole file line-by-line and remember the last session_info.name.
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(256 * 1024)
    let leftover = ''
    let offset = 0
    let lastName: string | null = null

    while (true) {
      const n = readSync(fd, buf, 0, buf.length, offset)
      if (n <= 0) break
      offset += n

      const chunk = leftover + buf.subarray(0, n).toString('utf8')
      const lines = chunk.split(/\r?\n/)
      leftover = lines.pop() ?? ''

      for (const line0 of lines) {
        const line = line0.trim()
        if (!line) continue
        try {
          const obj = JSON.parse(line) as any
          if (obj?.type === 'session_info' && typeof obj?.name === 'string' && obj.name.trim()) {
            lastName = obj.name.trim()
          }
        } catch {
          // ignore
        }
      }
    }

    // Best-effort: parse leftover if it was a full line without trailing newline.
    const tailLine = leftover.trim()
    if (tailLine) {
      try {
        const obj = JSON.parse(tailLine) as any
        if (obj?.type === 'session_info' && typeof obj?.name === 'string' && obj.name.trim()) {
          lastName = obj.name.trim()
        }
      } catch {
        // ignore
      }
    }

    return lastName
  } catch {
    return null
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
  }
}

function pickUpdatedAtFromTail(tail: string): string | null {
  // pi's `/resume` effectively orders sessions by last *message* activity.
  // We scan backwards and pick the timestamp of the most recent entry with type === "message".
  const lines = tail.split(/\r?\n/)

  // 1) Prefer the most recent message entry.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      if (obj?.type !== 'message') continue
      const ts = typeof obj?.timestamp === 'string' ? obj.timestamp : null
      if (!ts) continue
      const d = new Date(ts)
      if (Number.isFinite(d.getTime())) return d.toISOString()
    } catch {
      // ignore
    }
  }

  // 2) Fallback: any valid timestamp (covers sessions that somehow have no messages).
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      const ts = typeof obj?.timestamp === 'string' ? obj.timestamp : null
      if (!ts) continue
      const d = new Date(ts)
      if (Number.isFinite(d.getTime())) return d.toISOString()
    } catch {
      // ignore
    }
  }

  return null
}

function pickFirstUserMessageTitle(text: string): string | null {
  const lines = text.split(/\r?\n/)
  const limit = Math.min(lines.length, FALLBACK_MAX_LINES)

  for (let i = 0; i < limit; i++) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      if (obj?.type === 'message' && obj?.message?.role === 'user') {
        const content = obj?.message?.content
        if (typeof content === 'string') return content.slice(0, 80)
        if (Array.isArray(content)) {
          const t = content.find((c: any) => c?.type === 'text' && typeof c?.text === 'string')
          if (t?.text) return String(t.text).slice(0, 80)
        }
      }
    } catch {
      // ignore
    }
  }

  return null
}

function pickFallbackTitleFromHead(path: string): string | null {
  // Fallback to the first user message inside a bounded head window.
  const head = readHead(path, DEFAULT_HEAD_BYTES)
  if (head === null) return null

  const title = pickFirstUserMessageTitle(head.text)
  if (title || !head.truncated) return title

  // Retry once with a bigger window: the first user message may be one huge line that
  // reaches past the head window (the largest seen in practice is ~300KB).
  const wider = readHead(path, FALLBACK_MAX_BYTES)
  return wider ? pickFirstUserMessageTitle(wider.text) : null
}

export function listPiSessions(): PiSessionListItem[] {
  const sessionsDir = getPiSessionsDir()
  const files: string[] = []
  walkJsonlFiles(sessionsDir, files)

  const items: PiSessionListItem[] = []

  for (const file of files) {
    let st: Stats
    try {
      st = statSync(file)
    } catch {
      // File disappeared between the walk and now.
      continue
    }

    const first = readFirstLine(file)
    if (!first) continue
    const header = parseSessionHeader(first)
    if (!header) continue

    let updatedAt: string | null = null

    let title: string | null = null
    try {
      const tail = readTail(file, st.size)
      title = pickTitleFromTail(tail)
      updatedAt = pickUpdatedAtFromTail(tail)
    } catch {
      // ignore
    }

    // If the session was named early and grew large, it may fall outside of the tail window.
    // When the tail window already covered the whole file, a full scan cannot find anything new.
    if (!title && st.size > DEFAULT_TAIL_BYTES) {
      title = scanSessionInfoNameFromFile(file)
    }

    // Fallback for updatedAt when we couldn't parse timestamps from tail.
    if (!updatedAt) {
      updatedAt = st.mtime.toISOString()
    }

    if (!title) {
      title = pickFallbackTitleFromHead(file)
    }

    items.push({
      sessionId: header.sessionId,
      cwd: header.cwd,
      title,
      updatedAt,
      sessionFile: file
    })
  }

  // Sort most recent first.
  items.sort((a, b) => {
    const aa = a.updatedAt ?? ''
    const bb = b.updatedAt ?? ''
    return bb.localeCompare(aa)
  })

  return items
}

export function findPiSession(sessionId: string): PiSessionListItem | null {
  const all = listPiSessions()
  return all.find(s => s.sessionId === sessionId) ?? null
}

export function findPiSessionFile(sessionId: string): string | null {
  return findPiSession(sessionId)?.sessionFile ?? null
}

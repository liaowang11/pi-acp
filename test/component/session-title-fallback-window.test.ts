import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listPiSessions } from '../../src/acp/pi-sessions.js'

// The first-user-message fallback must stay inside a bounded head window: reading whole
// sessions is what made session/list slow on large session stores.

const HEADER = JSON.stringify({
  type: 'session',
  version: 3,
  id: 'sess-1',
  timestamp: '2026-01-01T00:00:00.000Z',
  cwd: '/tmp/project'
})

function assistantLine(text: string, timestamp = '2026-01-01T00:00:02.000Z'): string {
  return JSON.stringify({
    type: 'message',
    id: 'filler',
    parentId: null,
    timestamp,
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  })
}

function userLine(text: string, timestamp = '2026-01-01T00:00:01.000Z'): string {
  return JSON.stringify({
    type: 'message',
    id: 'user-1',
    parentId: null,
    timestamp,
    message: { role: 'user', content: text }
  })
}

function withSessionsDir<T>(files: Record<string, string>, run: () => T): T {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  mkdirSync(sessionsDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(sessionsDir, name), content, { encoding: 'utf8' })
  }

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  try {
    return run()
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
}

test('listPiSessions: picks a first user message that is one multi-hundred-KB line', () => {
  const longPrompt = 'skill body '.repeat(25 * 1024) // ~275KB, well past the 64KB head window

  const title = withSessionsDir({ 's.jsonl': [HEADER, userLine(longPrompt)].join('\n') + '\n' }, () => {
    const s = listPiSessions().find(x => x.sessionId === 'sess-1')
    assert.ok(s)
    return s.title
  })

  assert.equal(title, longPrompt.slice(0, 80))
})

test('listPiSessions: stops at the fallback window instead of reading the whole session', () => {
  // ~700KB of filler pushes the first user message past the 512KB fallback window.
  const filler = Array.from({ length: 350 }, (_, i) => assistantLine('y'.repeat(2000), `2026-01-01T01:${String(i % 60).padStart(2, '0')}:00.000Z`)).join('\n')

  const title = withSessionsDir(
    { 's.jsonl': [HEADER, filler, userLine('this message is outside the window')].join('\n') + '\n' },
    () => {
      const s = listPiSessions().find(x => x.sessionId === 'sess-1')
      assert.ok(s)
      return s.title
    }
  )

  assert.equal(title, null)
})

test('listPiSessions: still resolves a title for sessions with more than 2000 lines', () => {
  const filler = Array.from({ length: 3000 }, (_, i) => assistantLine('z'.repeat(2000), `2026-01-01T02:${String(i % 60).padStart(2, '0')}:00.000Z`)).join('\n')
  const body = [HEADER, userLine('title from the second line'), filler].join('\n') + '\n'

  const title = withSessionsDir({ 's.jsonl': body }, () => {
    const s = listPiSessions().find(x => x.sessionId === 'sess-1')
    assert.ok(s)
    return s.title
  })

  assert.equal(title, 'title from the second line')
})

test('listPiSessions: prefers a session_info name over the first user message in a small session', () => {
  const info = JSON.stringify({
    type: 'session_info',
    id: 'i1',
    parentId: null,
    timestamp: '2026-01-01T00:00:03.000Z',
    name: 'Explicit name'
  })
  const body = [HEADER, userLine('first user message'), info].join('\n') + '\n'

  const title = withSessionsDir({ 's.jsonl': body }, () => {
    const s = listPiSessions().find(x => x.sessionId === 'sess-1')
    assert.ok(s)
    return s.title
  })

  assert.equal(title, 'Explicit name')
})

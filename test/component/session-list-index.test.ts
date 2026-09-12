import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listPiSessions } from '../../src/acp/pi-sessions.js'
import { SESSION_INDEX_VERSION } from '../../src/acp/session-index.js'

// A listing walks every session file the store contains, so unchanged files are served
// from a persisted index instead of being re-read.

function sessionFile(cwd: string, id: string): string {
  return JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00.000Z', cwd })
}

function userMessage(text: string): string {
  return JSON.stringify({
    type: 'message',
    id: 'm1',
    parentId: null,
    timestamp: '2026-01-01T00:00:01.000Z',
    message: { role: 'user', content: text }
  })
}

function sessionInfo(name: string): string {
  return JSON.stringify({
    type: 'session_info',
    id: 'i1',
    parentId: null,
    timestamp: '2026-01-01T00:00:02.000Z',
    name
  })
}

function setup(files: Record<string, string[]>) {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  const sessionsDir = join(root, 'sessions', '--project--')
  mkdirSync(sessionsDir, { recursive: true })

  for (const [name, lines] of Object.entries(files)) {
    writeFileSync(join(sessionsDir, name), lines.join('\n') + '\n', { encoding: 'utf8' })
  }

  // The fallback sessions directory is <agentDir>/sessions, so index keys are relative to it.
  const key = (name: string) => join('--project--', name)

  return { root, sessionsDir, indexPath: join(root, 'pi-acp-session-index.json'), key }
}

function withAgentDir<T>(root: string, run: () => T): T {
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  try {
    return run()
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
}

function readIndex(path: string): { version: number; sessionsDir: string; files: Record<string, any> } {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

test('listPiSessions: writes an index entry per session file', () => {
  const { root, sessionsDir, indexPath, key } = setup({ 's.jsonl': [sessionFile('/project', 'sess-1'), userMessage('real title')] })

  withAgentDir(root, () => {
    assert.equal(listPiSessions()[0]?.title, 'real title')
  })

  const index = readIndex(indexPath)
  assert.equal(index.version, SESSION_INDEX_VERSION)
  assert.equal(index.sessionsDir, join(root, 'sessions'))
  assert.equal(index.files[key('s.jsonl')]?.title, 'real title')
  assert.equal(index.files[key('s.jsonl')]?.sessionId, 'sess-1')
  assert.equal(index.files[key('s.jsonl')]?.size, statSync(join(sessionsDir, 's.jsonl')).size)
})

test('listPiSessions: serves unchanged files from the index instead of re-reading them', () => {
  const { root, sessionsDir, indexPath, key } = setup({ 's.jsonl': [sessionFile('/project', 'sess-1'), userMessage('real title')] })

  withAgentDir(root, () => {
    listPiSessions()

    // Forge an index entry for the unchanged file. A cache hit must return it verbatim.
    const st = statSync(join(sessionsDir, 's.jsonl'))
    writeFileSync(
      indexPath,
      JSON.stringify({
        version: SESSION_INDEX_VERSION,
        sessionsDir: join(root, 'sessions'),
        files: {
          [key('s.jsonl')]: {
            size: st.size,
            mtimeMs: st.mtimeMs,
            sessionId: 'sess-1',
            cwd: '/project',
            title: 'title from the index',
            updatedAt: '2026-01-01T00:00:01.000Z'
          }
        }
      }),
      'utf-8'
    )

    const listed = listPiSessions()
    assert.equal(listed[0]?.title, 'title from the index')
    assert.equal(listed[0]?.updatedAt, '2026-01-01T00:00:01.000Z')
    assert.equal(listed[0]?.sessionFile, join(sessionsDir, 's.jsonl'))
  })
})

test('listPiSessions: re-reads and updates a session that changed', () => {
  const { root, sessionsDir } = setup({ 's.jsonl': [sessionFile('/project', 'sess-1'), userMessage('first title')] })

  withAgentDir(root, () => {
    assert.equal(listPiSessions()[0]?.title, 'first title')

    writeFileSync(
      join(sessionsDir, 's.jsonl'),
      [sessionFile('/project', 'sess-1'), userMessage('first title'), sessionInfo('renamed')].join('\n') + '\n',
      'utf-8'
    )

    assert.equal(listPiSessions()[0]?.title, 'renamed')
  })
})

test('listPiSessions: ignores an index written for a different sessions directory', () => {
  const { root, indexPath } = setup({ 's.jsonl': [sessionFile('/project', 'sess-1'), userMessage('real title')] })

  writeFileSync(
    indexPath,
    JSON.stringify({
      version: SESSION_INDEX_VERSION,
      sessionsDir: '/somewhere/else',
      files: { 's.jsonl': { size: 1, mtimeMs: 1, sessionId: 'stale', cwd: '/other', title: 'stale title', updatedAt: null } }
    }),
    'utf-8'
  )

  withAgentDir(root, () => {
    const listed = listPiSessions()
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.sessionId, 'sess-1')
    assert.equal(listed[0]?.title, 'real title')
  })
})

test('listPiSessions: rebuilds a corrupt index', () => {
  const { root, indexPath, key } = setup({ 's.jsonl': [sessionFile('/project', 'sess-1'), userMessage('real title')] })
  writeFileSync(indexPath, 'not json at all', 'utf-8')

  withAgentDir(root, () => {
    assert.equal(listPiSessions()[0]?.title, 'real title')
  })

  assert.equal(readIndex(indexPath).files[key('s.jsonl')]?.title, 'real title')
})

test('listPiSessions: drops index entries for deleted sessions', () => {
  const { root, sessionsDir, indexPath, key } = setup({
    'a.jsonl': [sessionFile('/project', 'sess-a'), userMessage('a')],
    'b.jsonl': [sessionFile('/project', 'sess-b'), userMessage('b')]
  })

  withAgentDir(root, () => {
    assert.equal(listPiSessions().length, 2)

    rmSync(join(sessionsDir, 'b.jsonl'))

    const listed = listPiSessions()
    assert.deepEqual(
      listed.map(s => s.sessionId),
      ['sess-a']
    )
  })

  assert.deepEqual(Object.keys(readIndex(indexPath).files), [key('a.jsonl')])
})

test('listPiSessions: never fails a listing when the index cannot be written', () => {
  const { root, indexPath } = setup({ 's.jsonl': [sessionFile('/project', 'sess-1'), userMessage('real title')] })

  // A file where the index directory would have to go makes the write fail.
  writeFileSync(join(root, 'not-a-dir'), 'x', 'utf-8')

  withAgentDir(root, () => {
    const unusable = join(root, 'not-a-dir', 'index.json')
    assert.equal(listPiSessions({ indexFile: unusable })[0]?.title, 'real title')
  })

  assert.throws(() => readFileSync(indexPath, 'utf-8'))
})

test('listPiSessions: ignores malformed index entries', () => {
  const { root, sessionsDir } = setup({ 's.jsonl': [sessionFile('/project', 'sess-1'), userMessage('real title')] })

  withAgentDir(root, () => {
    listPiSessions()

    const indexPath = join(root, 'pi-acp-session-index.json')
    const st = statSync(join(sessionsDir, 's.jsonl'))
    writeFileSync(
      indexPath,
      JSON.stringify({
        version: SESSION_INDEX_VERSION,
        sessionsDir: join(root, 'sessions'),
        files: {
          's.jsonl': { size: st.size, mtimeMs: st.mtimeMs, sessionId: 'sess-1', title: 'missing cwd and size types are wrong' },
          'gone.jsonl': { size: 1, mtimeMs: 1, sessionId: 'stale', cwd: '/other', title: 'stale', updatedAt: null }
        }
      }),
      'utf-8'
    )

    const listed = listPiSessions()
    assert.deepEqual(
      listed.map(s => s.sessionId),
      ['sess-1']
    )
    assert.equal(listed[0]?.title, 'real title')
  })
})

test('listPiSessions: does not touch the index when it is disabled', () => {
  const { root, indexPath } = setup({ 's.jsonl': [sessionFile('/project', 'sess-1'), userMessage('real title')] })

  withAgentDir(root, () => {
    assert.equal(listPiSessions({ indexFile: null })[0]?.title, 'real title')
  })

  assert.throws(() => readFileSync(indexPath, 'utf-8'))
})

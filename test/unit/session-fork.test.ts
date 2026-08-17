import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('PiAcpAgent: initialize advertises sessionCapabilities.fork', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)

  const res = await agent.initialize({ protocolVersion: 1 } as any)

  assert.deepEqual((res.agentCapabilities?.sessionCapabilities as any)?.fork, {})
})

test('PiAcpAgent: forkSession rejects an unknown sessionId', async () => {
  const conn = new FakeAgentSideConnection()
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-fork-unknown-'))
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR

  // Point pi session discovery at an empty dir so the fallback lookup misses too.
  process.env.PI_CODING_AGENT_DIR = root

  try {
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).store = new SessionStore(join(root, 'session-map.json'))

    await assert.rejects(
      () => agent.unstable_forkSession({ sessionId: 'no-such-session', cwd: root } as any),
      (e: any) => e?.code === -32602 && String(e?.data ?? '').includes('no-such-session')
    )
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir
  }
})

test('PiAcpAgent: forkSession rejects a relative cwd', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)

  await assert.rejects(
    () => agent.unstable_forkSession({ sessionId: 'whatever', cwd: 'relative/path' } as any),
    (e: any) => e?.code === -32602 && String(e?.data ?? '').includes('cwd')
  )
})

test('PiAcpAgent: forkSession rejects a session whose file is not on disk yet', async () => {
  // pi does not persist a session file until the first message, and `pi --fork`
  // exits on a missing source file. Reject up front with a clear error.
  const conn = new FakeAgentSideConnection()
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-fork-nofile-'))

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  const store = new SessionStore(join(root, 'session-map.json'))
  store.upsert({ sessionId: 'empty-session', cwd: root, sessionFile: join(root, 'missing.jsonl') })
  ;(agent as any).store = store

  await assert.rejects(
    () => agent.unstable_forkSession({ sessionId: 'empty-session', cwd: root } as any),
    (e: any) => e?.code === -32602 && String(e?.data ?? '').includes('no persisted history')
  )
})

test('PiAcpAgent: forkSession spawns pi with --fork on the source file and registers the new session', async () => {
  const conn = new FakeAgentSideConnection()
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-fork-'))
  const sourceFile = join(root, 'sessions', 'source.jsonl')
  const forkedFile = join(root, 'sessions', 'forked.jsonl')
  const sessionMapPath = join(root, 'session-map.json')
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR

  process.env.PI_CODING_AGENT_DIR = root
  mkdirSync(join(root, 'sessions'), { recursive: true })
  writeFileSync(
    sourceFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'source-session',
      timestamp: '2026-08-17T00:00:00.000Z',
      cwd: root
    }) + '\n',
    'utf-8'
  )

  const spawnCalls: any[] = []
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push(params)
    // pi --fork starts on a copy of the source conversation under a new session id/file.
    return {
      onEvent: () => () => {},
      async getState() {
        return {
          sessionId: 'forked-session',
          sessionFile: forkedFile,
          thinkingLevel: 'medium',
          model: { provider: 'test', id: 'alpha' }
        }
      },
      async getAvailableModels() {
        return { models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }] }
      },
      async getAvailableThinkingLevels() {
        return { levels: ['off', 'low', 'medium', 'high'] }
      },
      dispose() {}
    } as any
  }

  try {
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    const store = new SessionStore(sessionMapPath)
    store.upsert({ sessionId: 'source-session', cwd: root, sessionFile: sourceFile })
    ;(agent as any).store = store
    ;((agent as any).sessions as any).store = new SessionStore(sessionMapPath)

    const res = await agent.unstable_forkSession({
      sessionId: 'source-session',
      cwd: root,
      mcpServers: []
    } as any)

    assert.deepEqual(spawnCalls, [
      {
        cwd: root,
        forkPath: sourceFile,
        piCommand: process.env.PI_ACP_PI_COMMAND
      }
    ])
    assert.equal(res.sessionId, 'forked-session')
    assert.ok(Array.isArray((res as any).configOptions))
    assert.equal(store.get('forked-session')?.sessionFile, forkedFile)
    // Source mapping stays intact.
    assert.equal(store.get('source-session')?.sessionFile, sourceFile)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir
  }
})

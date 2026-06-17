import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('PiAcpAgent: initialize advertises session list, resume, and fork capabilities', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))

  const result = await agent.initialize({ protocolVersion: 1 } as any)

  assert.deepEqual(result.agentCapabilities.sessionCapabilities, {
    list: {},
    resume: {},
    fork: {}
  })
})

test('PiAcpAgent: resumeSession restores without replaying prior messages', async () => {
  const conn = new FakeAgentSideConnection()
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-resume-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  const sessionFile = join(sessionsDir, '0000_resume_session.jsonl')
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR
  const prevHome = process.env.HOME

  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'resume-session',
      timestamp: '2026-06-18T00:00:00.000Z',
      cwd: '/tmp/project'
    }) + '\n',
    'utf-8'
  )

  process.env.PI_CODING_AGENT_DIR = root
  process.env.HOME = root

  const spawnCalls: any[] = []
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push(params)
    return {
      onEvent: () => () => {},
      getAvailableModels: async () => ({
        models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }]
      }),
      getState: async () => ({
        thinkingLevel: 'medium',
        model: { provider: 'test', id: 'alpha' }
      }),
      getCommands: async () => ({ commands: [] })
    } as any
  }

  try {
    const agent = new PiAcpAgent(asAgentConn(conn))
    const result = await (agent as any).resumeSession({
      sessionId: 'resume-session',
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: null
    })

    assert.deepEqual(spawnCalls, [
      {
        cwd: '/tmp/project',
        sessionPath: sessionFile,
        piCommand: process.env.PI_ACP_PI_COMMAND
      }
    ])
    assert.equal(result.models?.currentModelId, 'test/alpha')
    assert.equal(result.modes.currentModeId, 'medium')
    assert.deepEqual(
      conn.updates.filter(update => (update as any).update?.sessionUpdate !== 'available_commands_update'),
      []
    )
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
  }
})

test('PiAcpAgent: unstable_forkSession clones stored session into a new session file', async () => {
  const conn = new FakeAgentSideConnection()
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-fork-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  const sessionFile = join(sessionsDir, '0000_fork_source.jsonl')
  const prevHome = process.env.HOME

  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'fork-source',
        timestamp: '2026-06-18T00:00:00.000Z',
        cwd: '/tmp/project'
      }),
      JSON.stringify({
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: '2026-06-18T00:00:01.000Z',
        message: { role: 'user', content: 'hello fork' }
      })
    ].join('\n') + '\n',
    'utf-8'
  )

  process.env.HOME = root

  const spawnCalls: any[] = []
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push(params)
    return {
      onEvent: () => () => {},
      getAvailableModels: async () => ({
        models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }]
      }),
      getState: async () => ({
        sessionId: JSON.parse(readFileSync(params.sessionPath, 'utf-8').split('\n')[0] || '{}').id,
        sessionFile: params.sessionPath,
        thinkingLevel: 'medium',
        model: { provider: 'test', id: 'alpha' }
      }),
      getCommands: async () => ({ commands: [] })
    } as any
  }

  try {
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = {
      get(sessionId: string) {
        if (sessionId !== 'fork-source') return null
        return {
          sessionId,
          cwd: '/tmp/project',
          sessionFile,
          updatedAt: new Date().toISOString()
        }
      },
      upsert() {},
      delete() {}
    }

    const result = await (agent as any).unstable_forkSession({
      sessionId: 'fork-source',
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: null
    })

    assert.equal(spawnCalls.length, 1)
    assert.equal(spawnCalls[0]?.cwd, '/tmp/project')
    assert.notEqual(spawnCalls[0]?.sessionPath, sessionFile)
    assert.equal(dirname(spawnCalls[0]?.sessionPath), dirname(sessionFile))

    const sourceLines = readFileSync(sessionFile, 'utf-8').trim().split('\n')
    const forkedLines = readFileSync(spawnCalls[0]?.sessionPath, 'utf-8').trim().split('\n')
    assert.equal(sourceLines.length, forkedLines.length)

    const sourceHeader = JSON.parse(sourceLines[0] ?? '{}')
    const forkedHeader = JSON.parse(forkedLines[0] ?? '{}')
    assert.notEqual(forkedHeader.id, sourceHeader.id)
    assert.equal(forkedHeader.cwd, '/tmp/project')
    assert.equal(result.sessionId, forkedHeader.id)
    assert.equal(result.models?.currentModelId, 'test/alpha')
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
  }
})

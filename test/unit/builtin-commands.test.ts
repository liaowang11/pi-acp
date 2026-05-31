import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}
  get(_id: string) {
    return this.session
  }
}

test('PiAcpAgent: /steering is handled adapter-side', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  proc.getState = async () => ({ steeringMode: 'one-at-a-time' })

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc, fileCommands: [] }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/steering' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(proc.prompts.length, 0)
  const last = conn.updates.at(-1)
  assert.match((last as any).update.content.text, /Steering mode: one-at-a-time/)
})

test('PiAcpAgent: /name sets session display name adapter-side', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  let setTo: string | null = null
  proc.setSessionName = async (name: string) => {
    setTo = name
  }

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc, fileCommands: [] }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/name My Session' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(proc.prompts.length, 0)
  assert.equal(setTo, 'My Session')
  const info = conn.updates.find(u => (u as any).update?.sessionUpdate === 'session_info_update')
  assert.equal((info as any)?.update?.title, 'My Session')

  const last = conn.updates.at(-1)
  assert.match((last as any).update.content.text, /Session name set: My Session/)
})

test('PiAcpAgent: known extension commands are detached from later real prompts', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  proc.getCommands = async () => ({ commands: [{ name: 'cache', source: 'extension' }] })

  let promptCall: { message: string; images: unknown[]; opts: unknown } | null = null
  const session = {
    sessionId: 's1',
    proc,
    fileCommands: [],
    isExtensionCommand: async (name: string) => name === 'cache',
    prompt: async (message: string, images: unknown[], opts: unknown) => {
      promptCall = { message, images, opts }
      return 'end_turn'
    },
    wasCancelRequested: () => false
  }

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(session) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/cache graph' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.deepEqual(promptCall, {
    message: '/cache graph',
    images: [],
    opts: { detached: true }
  })
})

test('PiAcpAgent: prompt-template commands stay on the normal prompt path', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  proc.getCommands = async () => ({ commands: [{ name: 'review', source: 'prompt' }] })

  let promptCall: { message: string; images: unknown[]; opts: unknown } | null = null
  const session = {
    sessionId: 's1',
    proc,
    fileCommands: [],
    isExtensionCommand: async () => false,
    prompt: async (message: string, images: unknown[], opts: unknown) => {
      promptCall = { message, images, opts }
      return 'end_turn'
    },
    wasCancelRequested: () => false
  }

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(session) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/review src/acp/session.ts' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.deepEqual(promptCall, {
    message: '/review src/acp/session.ts',
    images: [],
    opts: undefined
  })
})

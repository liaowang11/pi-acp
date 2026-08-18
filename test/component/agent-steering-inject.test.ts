import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}
  maybeGet(_id: string) {
    return this.session
  }
  get(_id: string) {
    return this.session
  }
}

function agentWithSession(session: any): { agent: PiAcpAgent; conn: FakeAgentSideConnection } {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(session) as any
  return { agent, conn }
}

test('PiAcpAgent: initialize advertises mid-turn steering support', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  const res = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as any)

  // The capability lives at the top-level _meta, a sibling of agentCapabilities,
  // per the steering extension other adapters already implement.
  assert.equal((res._meta as any)?.steering?.supported, true)
})

test('PiAcpAgent: _session/steering delivers the prompt to the running turn', async () => {
  const steers: Array<{ message: string; images: unknown[] }> = []
  const { agent } = agentWithSession({
    sessionId: 's1',
    proc: new FakePiRpcProcess(),
    steer: async (message: string, images: unknown[]) => {
      steers.push({ message, images })
      return 'injected'
    }
  })

  const res = await (agent as any).extMethod('_session/steering', {
    sessionId: 's1',
    prompt: [{ type: 'text', text: 'change course' }]
  })

  assert.deepEqual(res, { outcome: 'injected' })
  assert.equal(steers.length, 1)
  assert.equal(steers[0].message, 'change course')
})

test('PiAcpAgent: _session/steering reports promptRequired with no turn running', async () => {
  let steered = false
  const { agent } = agentWithSession({
    sessionId: 's1',
    proc: new FakePiRpcProcess(),
    steer: async () => {
      steered = true
      return 'noRunningTurn'
    }
  })

  const res = await (agent as any).extMethod('_session/steering', {
    sessionId: 's1',
    prompt: [{ type: 'text', text: 'change course' }],
    _meta: { steering: { idleBehavior: 'promptRequired' } }
  })

  // The prompt is NOT consumed: the client re-sends it as a normal session/prompt,
  // whose request then owns the turn's updates and result.
  assert.deepEqual(res, { outcome: 'promptRequired', reason: 'noRunningTurn' })
  assert.equal(steered, true)
})

test('PiAcpAgent: _session/steering reports failed when pi rejects the steer', async () => {
  const { agent } = agentWithSession({
    sessionId: 's1',
    proc: new FakePiRpcProcess(),
    steer: async () => {
      throw new Error('pi prompt failed: nope')
    }
  })

  const res = await (agent as any).extMethod('_session/steering', {
    sessionId: 's1',
    prompt: [{ type: 'text', text: 'change course' }]
  })

  assert.equal((res as any).outcome, 'failed')
})

test('PiAcpAgent: _session/steering rejects malformed params', async () => {
  const { agent } = agentWithSession({
    sessionId: 's1',
    proc: new FakePiRpcProcess(),
    steer: async () => 'injected'
  })

  await assert.rejects(() => (agent as any).extMethod('_session/steering', { prompt: [] }))
  await assert.rejects(() => (agent as any).extMethod('_session/steering', { sessionId: 's1' }))
  await assert.rejects(() => (agent as any).extMethod('_session/steering', { sessionId: 's1', prompt: [] }))
})

test('PiAcpAgent: unknown extension methods stay method-not-found', async () => {
  const { agent } = agentWithSession({ sessionId: 's1', steer: async () => 'injected' })

  // Implementing extMethod takes over the SDK's default branch, so anything the
  // adapter does not handle has to keep failing as an unknown method.
  await assert.rejects(
    () => (agent as any).extMethod('_session/not-a-real-method', { sessionId: 's1' }),
    /not.?found|-32601/i
  )
})

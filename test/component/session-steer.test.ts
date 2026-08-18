import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession(proc: FakePiRpcProcess, conn: FakeAgentSideConnection): PiAcpSession {
  return new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
}

test('PiAcpSession: steer sends the message to the running turn, not the queue', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(proc, conn)

  const turn = session.prompt('long task')
  proc.emit({ type: 'agent_start' } as any)

  assert.equal(await session.steer('change course'), 'injected')

  // Delivered as a steering message on pi's own channel: pi rejects a plain
  // second prompt while the agent loop runs ("Specify streamingBehavior").
  assert.equal(proc.prompts.length, 2)
  assert.equal(proc.prompts[1].message, 'change course')
  assert.equal(proc.prompts[1].streamingBehavior, 'steer')

  // The running turn still owns the outcome: pi emits one agent_settled for the
  // whole loop, including the steered cycle.
  proc.emit({ type: 'agent_end' } as any)
  proc.emit({ type: 'agent_settled' } as any)
  assert.equal(await turn, 'end_turn')

  // No queued turn was created, so nothing starts after the turn ends.
  assert.equal(proc.prompts.length, 2)
})

test('PiAcpSession: steer reports noRunningTurn when idle', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(proc, conn)

  // pi accepts a steering message even when idle and would run it as its own
  // agent loop, with no ACP request owning the output, so the adapter gates on
  // having a turn in flight.
  assert.equal(await session.steer('change course'), 'noRunningTurn')
  assert.equal(proc.prompts.length, 0)
})

test('PiAcpSession: steer expands file slash commands like a prompt does', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [{ name: 'review', description: 'Review', content: 'Review the diff' } as any]
  })

  session.prompt('long task')
  proc.emit({ type: 'agent_start' } as any)
  await session.steer('/review')

  assert.equal(proc.prompts[1].message, 'Review the diff')
})

test('PiAcpSession: a steered turn still cancels as cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(proc, conn)

  const turn = session.prompt('long task')
  proc.emit({ type: 'agent_start' } as any)
  await session.steer('change course')

  await session.cancel()
  proc.emit({ type: 'agent_end' } as any)
  proc.emit({ type: 'agent_settled' } as any)

  assert.equal(await turn, 'cancelled')
  assert.equal(proc.abortCount, 1)
})

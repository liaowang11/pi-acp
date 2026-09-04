import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'

class FakeConn {
  updates: any[] = []
  async sessionUpdate(msg: any) {
    this.updates.push(msg)
  }
}

test('PiAcpAgent: does not expose session modes', async () => {
  const conn = new FakeConn()
  const agent = new PiAcpAgent(conn as any)

  // Session modes were removed: pi has no ask/architect/code-style modes, and
  // thinking level is exposed via the thought_level config option instead.
  assert.equal(typeof (agent as any).setSessionMode, 'undefined')
})

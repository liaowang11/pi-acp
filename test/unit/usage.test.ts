import test from 'node:test'
import assert from 'node:assert/strict'
import { toUsageUpdate, toPromptUsage } from '../../src/acp/usage.js'

test('toUsageUpdate: maps context usage and cost', () => {
  const update = toUsageUpdate({
    contextUsage: { tokens: 53000, contextWindow: 200000, percent: 26.5 },
    cost: 0.045
  })
  assert.deepEqual(update, {
    sessionUpdate: 'usage_update',
    used: 53000,
    size: 200000,
    cost: { amount: 0.045, currency: 'USD' }
  })
})

test('toUsageUpdate: omits cost when stats.cost is not a number', () => {
  const update = toUsageUpdate({ contextUsage: { tokens: 10, contextWindow: 1000 } })
  assert.deepEqual(update, { sessionUpdate: 'usage_update', used: 10, size: 1000 })
})

test('toUsageUpdate: defaults used to 0 when tokens missing', () => {
  const update = toUsageUpdate({ contextUsage: { contextWindow: 1000 } })
  assert.equal(update?.used, 0)
})

test('toUsageUpdate: returns undefined when contextWindow missing or zero', () => {
  assert.equal(toUsageUpdate({}), undefined)
  assert.equal(toUsageUpdate({ contextUsage: { tokens: 5 } }), undefined)
  assert.equal(toUsageUpdate({ contextUsage: { tokens: 5, contextWindow: 0 } }), undefined)
})

test('toPromptUsage: maps cumulative token breakdown', () => {
  const usage = toPromptUsage({
    tokens: { input: 35000, output: 12000, cacheRead: 5000, cacheWrite: 1000, total: 53000 }
  })
  assert.deepEqual(usage, {
    totalTokens: 53000,
    inputTokens: 35000,
    outputTokens: 12000,
    cachedReadTokens: 5000,
    cachedWriteTokens: 1000
  })
})

test('toPromptUsage: defaults missing fields to 0', () => {
  assert.deepEqual(toPromptUsage({ tokens: {} }), {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0
  })
})

test('toPromptUsage: returns undefined when tokens missing', () => {
  assert.equal(toPromptUsage({}), undefined)
})

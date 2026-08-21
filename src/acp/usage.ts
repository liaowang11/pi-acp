export interface UsageCost {
  amount: number
  currency: string
}

// `usage_update` is not yet in the ACP SDK's SessionUpdate union (see ACP RFD #22).
// Defined locally so we can emit the forward-compatible shape without `any`.
export interface UsageUpdate {
  sessionUpdate: 'usage_update'
  used: number
  size: number
  cost?: UsageCost
}

export interface PromptUsage {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cachedReadTokens: number
  cachedWriteTokens: number
}

// Typed view of pi's get_session_stats result (the RPC layer returns it untyped).
export interface PiSessionStats {
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number }
  cost?: number
  contextUsage?: { tokens?: number; contextWindow?: number; percent?: number }
}

export function toUsageUpdate(stats: PiSessionStats): UsageUpdate | undefined {
  const cu = stats.contextUsage
  if (!cu?.contextWindow || cu.contextWindow <= 0) return undefined
  const update: UsageUpdate = {
    sessionUpdate: 'usage_update',
    used: cu.tokens ?? 0,
    size: cu.contextWindow
  }
  if (typeof stats.cost === 'number') update.cost = { amount: stats.cost, currency: 'USD' }
  return update
}

export function toPromptUsage(stats: PiSessionStats): PromptUsage | undefined {
  const t = stats.tokens
  if (!t) return undefined
  return {
    totalTokens: t.total ?? 0,
    inputTokens: t.input ?? 0,
    outputTokens: t.output ?? 0,
    cachedReadTokens: t.cacheRead ?? 0,
    cachedWriteTokens: t.cacheWrite ?? 0
  }
}

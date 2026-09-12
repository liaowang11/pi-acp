import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Storage owned by the ACP adapter.
 *
 * We intentionally keep this separate from pi's own ~/.pi/agent/* directory.
 */
export function getPiAcpDir(): string {
  return join(homedir(), '.pi', 'pi-acp')
}

export function getPiAcpSessionMapPath(): string {
  return join(getPiAcpDir(), 'session-map.json')
}

/**
 * pi's own configuration directory.
 *
 * Pi supports overriding it via PI_CODING_AGENT_DIR, and the session directory is read
 * from the settings.json it contains, so anything derived from sessions belongs next to
 * the agent dir rather than to a fixed home path.
 */
export function getPiAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), '.pi', 'agent')
}

export function getPiAcpSessionIndexPath(): string {
  return join(getPiAgentDir(), 'pi-acp-session-index.json')
}

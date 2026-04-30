/**
 * Config Fan-out
 *
 * Pushes raw runtime snapshots to all supervised workspace-runtime instances
 * after any MCP mutation. Called from agent-config routes.
 */

import { broadcastRuntimeConfig } from "./workspace-supervisor"
import { broadcastLocalAgentConfig } from "./local-agent-engine"

export async function fanOutConfig(): Promise<void> {
  await Promise.allSettled([
    broadcastRuntimeConfig(),
    broadcastLocalAgentConfig(),
  ])
}

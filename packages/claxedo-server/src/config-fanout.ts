/**
 * Config Fan-out
 *
 * Pushes raw runtime snapshots to all supervised workspace-runtime instances
 * after any MCP mutation. Called from agent-config routes.
 */

import { broadcastRuntimeConfig } from "./workspace-supervisor"
import { syncEmbeddedWorkspaceRuntimes } from "./embedded-workspace-runtime"
import { syncOpencodeMcpConfig } from "./opencode-mcp-sync"

export async function fanOutConfig(): Promise<void> {
  await Promise.allSettled([
    broadcastRuntimeConfig(),
    syncEmbeddedWorkspaceRuntimes(),
    syncOpencodeMcpConfig(),
  ])
}

/**
 * Config Fan-out
 *
 * Pushes raw runtime snapshots to all supervised workspace-runtime instances
 * after any MCP mutation. Called from agent-config routes.
 */

import { workspaceSupervisor } from "../workspace/supervisor-port"
import { syncEmbeddedWorkspaceRuntimes } from "../deployments/local/embedded-workspace-runtime"
import { syncOpencodeMcpConfig } from "../opencode/mcp-sync"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"

const log = Log.create({ service: "config-fanout" })

export async function fanOutConfig(): Promise<void> {
  const targets = [
    { name: "workspace/supervisor", run: () => workspaceSupervisor().broadcastRuntimeConfig() },
    { name: "deployments/local/embedded-workspace-runtime", run: syncEmbeddedWorkspaceRuntimes },
    { name: "opencode-mcp-sync", run: syncOpencodeMcpConfig },
  ] as const
  const results = await Promise.allSettled(targets.map((target) => target.run()))

  results.forEach((result, index) => {
    if (result.status === "fulfilled") return
    log.warn("config fan-out target failed", { target: targets[index]?.name })
  })
}

import { syncEmbeddedWorkspaceRuntimes } from "../deployments/local/embedded-workspace-runtime"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"

const log = Log.create({ service: "config-fanout" })

/**
 * Pushes the current runtime config to every embedded workspace runtime after
 * an agent-config mutation. The warning names the target only: a runtime's
 * rejection can quote the config it refused, secrets included.
 */
export async function fanOutConfig(): Promise<void> {
  try {
    await syncEmbeddedWorkspaceRuntimes()
  } catch (error) {
    log.warn("config fan-out target failed", { target: "deployments/local/embedded-workspace-runtime" })
    throw new Error("config fan-out failed", { cause: error })
  }
}

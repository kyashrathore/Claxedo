import type { AgentPluginHarnessId } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import type { AgentPluginHarnessProjectionAdapter } from "./types"

/** A conforming harness receives the exact retained standard plugin roots. */
export function nativeAgentPluginAdapter(harnessId: AgentPluginHarnessId): AgentPluginHarnessProjectionAdapter {
  return {
    harnessId,
    async project({ plugins }) {
      return {
        harnessId,
        pluginRoots: plugins.map((plugin) => ({
          pluginInstanceId: plugin.pluginInstanceId,
          root: plugin.root,
          dataRoot: plugin.dataRoot,
        })),
        diagnostics: [],
      }
    },
  }
}

import { claxedoMcpToolGroupInventory } from "@claxedo/mcp"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { SqliteUnsignedAgentPluginActivationStore } from "./activation/sqlite-store"
import {
  builtinPluginInstanceId,
  resolveBuiltinGroupActivation,
  type BuiltinDeployment,
} from "@claxedo/server-core/agent-plugins/builtin/plugin"
import type { UnsignedAgentPluginActivationStore } from "@claxedo/server-core/agent-plugins/activation/store"

/**
 * This machine serves its own documents, so that group reaches no further than
 * the process the session already runs in.
 */
export const LOCAL_BUILTIN_DEPLOYMENT: BuiltinDeployment = { documentsInProcess: true }

/**
 * The first-party tool groups this machine has turned on.
 *
 * Read on every call rather than snapshotted at boot, because the runtime that
 * injects the endpoint and the mount that serves it are both long-lived here:
 * a switch flipped in the Marketplace has to reach the next session and the
 * next request without restarting the daemon.
 *
 * Unsigned activation is machine-wide and written for every harness at once,
 * so `opencode`'s row answers for all of them.
 */
export function localBuiltinToolGroups(activations: UnsignedAgentPluginActivationStore): readonly string[] {
  return claxedoMcpToolGroupInventory()
    .filter((group) => {
      const { machineOverride } = activations.read(builtinPluginInstanceId(group.id), "opencode")
      return resolveBuiltinGroupActivation({
        groupId: group.id,
        harnessId: "opencode",
        deployment: LOCAL_BUILTIN_DEPLOYMENT,
        mode: "unsigned",
        ...(machineOverride === undefined ? {} : { machineOverride }),
      })
    })
    .map((group) => group.id)
}

/**
 * The reader every part of one process shares.
 *
 * The store is opened on first read rather than at composition: the endpoint
 * mount and the embedded runtime are both wired before the database is, and a
 * reader built eagerly would open it too early.
 */
export function localBuiltinToolGroupsReader(): () => readonly string[] {
  let activations: SqliteUnsignedAgentPluginActivationStore | undefined
  return () => {
    activations ??= new SqliteUnsignedAgentPluginActivationStore(ClaxedoDB.raw())
    return localBuiltinToolGroups(activations)
  }
}

import { appPluginToolGroupId } from "@claxedo/plugin-api/tools"
import { selectActivationAuthority } from "@claxedo/server-core/agent-plugins/activation/effective"
import type { SignedActivationSnapshot } from "@claxedo/server-core/agent-plugins/activation/store"
import type { AgentPluginHarnessId } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { CloudRootIdentity } from "@claxedo/server-core/plugins/server-plugin"
import type { D1SignedAgentPluginActivationStore } from "./activation/d1-store"

/**
 * The root grant group under which a cloud root carries its app plugin tools
 * grant. A root has it on exactly while at least one app plugin's tool group
 * is on for it, so the grant is minted, renewed and withdrawn with that.
 */
export const APP_PLUGIN_TOOLS_GRANT_GROUP = "app-plugin-tools"

/**
 * The tool switch is the same for every harness, and the root environment
 * reads every built-in group for this one, so one harness's row is the
 * reading everywhere.
 */
const CONSENT_HARNESS: AgentPluginHarnessId = "opencode"

function consented(pluginId: string, snapshot: SignedActivationSnapshot | undefined): boolean {
  return selectActivationAuthority({
    mode: "signed",
    pluginInstanceId: appPluginToolGroupId(pluginId),
    harnessId: CONSENT_HARNESS,
    claxedoDefault: true,
    pins: {},
    ...(snapshot?.projectOverride === undefined ? {} : { projectOverride: snapshot.projectOverride }),
    ...(snapshot?.userDefault === undefined ? {} : { userDefault: snapshot.userDefault }),
    ...(snapshot?.organizationDefault === undefined ? {} : { organizationDefault: snapshot.organizationDefault }),
  }).enabled
}

export type AppPluginToolConsent = Readonly<{
  /** Which of `pluginIds` the signed caller has the tool switch on for: their own choice, else the organization's, else on. */
  forCaller(auth: SignedControlPlaneAuth, pluginIds: readonly string[]): Promise<ReadonlySet<string>>
  /** The same reading as the root's owner, where a choice for the root's project comes first. */
  forRoot(root: CloudRootIdentity, pluginIds: readonly string[]): Promise<ReadonlySet<string>>
}>

/** Each plugin's tool switch, the activation subject `app-plugin:<pluginId>`, read from the signed activation store. */
export function appPluginToolConsent(activations: Pick<D1SignedAgentPluginActivationStore, "read" | "readRuntime">): AppPluginToolConsent {
  return {
    async forCaller(auth, pluginIds) {
      if (pluginIds.length === 0) return new Set()
      const snapshots = await activations.read(auth, { pluginInstanceIds: pluginIds.map(appPluginToolGroupId) })
      return new Set(pluginIds.filter((pluginId) => consented(pluginId, snapshots.get(appPluginToolGroupId(pluginId))?.[CONSENT_HARNESS])))
    },
    async forRoot(root, pluginIds) {
      const on = await Promise.all(pluginIds.map(async (pluginId) => {
        const snapshot = await activations.readRuntime({
          ownerUserId: root.userId,
          organizationId: root.orgId,
          projectId: root.projectId,
          workspaceId: root.workspaceId,
          pluginInstanceId: appPluginToolGroupId(pluginId),
          harnessId: CONSENT_HARNESS,
        })
        return consented(pluginId, snapshot) ? pluginId : undefined
      }))
      return new Set(on.filter((pluginId): pluginId is string => pluginId !== undefined))
    },
  }
}

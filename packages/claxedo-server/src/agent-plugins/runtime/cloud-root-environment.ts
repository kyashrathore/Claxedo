import type { SignedActivationSnapshot } from "@claxedo/server-core/agent-plugins/activation/store"
import {
  BUILTIN_TASKS_TOOL_GROUP,
  builtinPluginInstanceId,
  resolveBuiltinGroupActivation,
  type BuiltinDeployment,
  type BuiltinToolGroup,
} from "@claxedo/server-core/agent-plugins/builtin/plugin"
import type { AgentPluginHarnessId } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import { workspaceRuntimeMcpToolGroupsEnv } from "@claxedo/server-core/hosts/workspace-runtime/env"

/** One cloud root as the workspace authority records it. */
export type CloudRootIdentity = Readonly<{
  userId: string
  orgId: string
  projectId: string
  workspaceId: string
}>

export type CloudRootEnvironmentInput = Readonly<{
  activations: {
    readRuntime(input: {
      ownerUserId: string
      organizationId: string
      projectId: string
      workspaceId: string
      pluginInstanceId: string
      harnessId: AgentPluginHarnessId
    }): Promise<SignedActivationSnapshot>
  }
  builtIn: Readonly<{ groups: readonly BuiltinToolGroup[]; deployment: BuiltinDeployment }>
  /** The grant the Tasks group's tools present to the control plane, minted for one root. */
  tasksGrant: (root: CloudRootIdentity) => Promise<Record<string, string>>
}>

/**
 * The first-party consent and credentials one cloud root's sessions launch
 * with, as environment the sandbox reads.
 *
 * A sandbox has no project route, so what the project consented to has to
 * travel at launch, and it is read here as the workspace's recorded owner
 * rather than as any signed caller: the root that an ordinary create, a wake
 * after a checkpoint and a task Start each provision is the same root, and a
 * declaration that depended on which of them ran would let the same project
 * boot with different tools.
 *
 * The tool groups always travel, empty included. The Tasks grant rides with
 * them only when the Tasks group is among them, which is what makes the
 * consent and the capability a single act rather than a switch that hides
 * tools a session still holds a token for.
 */
export function createCloudRootEnvironment(input: CloudRootEnvironmentInput) {
  return async (root: CloudRootIdentity): Promise<Record<string, string>> => {
    const groups = await enabledBuiltinGroups(input, root)
    const environment = workspaceRuntimeMcpToolGroupsEnv(groups)
    if (!groups.includes(BUILTIN_TASKS_TOOL_GROUP)) return environment
    return { ...environment, ...(await input.tasksGrant(root)) }
  }
}

async function enabledBuiltinGroups(input: CloudRootEnvironmentInput, root: CloudRootIdentity): Promise<string[]> {
  const enabled = await Promise.all(input.builtIn.groups.map(async (group) => {
    const snapshot = await input.activations.readRuntime({
      ownerUserId: root.userId,
      organizationId: root.orgId,
      projectId: root.projectId,
      workspaceId: root.workspaceId,
      pluginInstanceId: builtinPluginInstanceId(group.id),
      harnessId: "opencode",
    })
    return resolveBuiltinGroupActivation({
      group,
      harnessId: "opencode",
      deployment: input.builtIn.deployment,
      mode: "signed",
      ...(snapshot.projectOverride === undefined ? {} : { projectOverride: snapshot.projectOverride }),
      ...(snapshot.userDefault === undefined ? {} : { userDefault: snapshot.userDefault }),
      ...(snapshot.organizationDefault === undefined ? {} : { organizationDefault: snapshot.organizationDefault }),
    }) ? group.id : undefined
  }))
  return enabled.filter((group): group is string => group !== undefined)
}

import type { SignedActivationSnapshot } from "@claxedo/server-core/agent-plugins/activation/store"
import {
  builtinPluginInstanceId,
  resolveBuiltinGroupActivation,
  type BuiltinDeployment,
  type BuiltinToolGroup,
} from "@claxedo/server-core/agent-plugins/builtin/plugin"
import type { AgentPluginHarnessId } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import { workspaceRuntimeMcpToolGroupsEnv } from "@claxedo/server-core/hosts/workspace-runtime/env"
import type { CloudRootGrantContribution, CloudRootIdentity } from "@claxedo/server-core/plugins/server-plugin"

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
  /** Each credential a root launches with while its project has that grant's group on. */
  grants: readonly Pick<CloudRootGrantContribution, "group" | "mint">[]
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
 * The tool groups always travel, empty included. Each grant rides with them
 * only when its group is among them — the Tasks capability with the Tasks
 * group, the owner grant with the subagents group — which is what makes each
 * consent and its capability a single act rather than a switch that hides
 * tools a session still holds a token for.
 */
export function createCloudRootEnvironment(input: CloudRootEnvironmentInput) {
  const toolGroups = createCloudRootToolGroups(input)
  return async (root: CloudRootIdentity): Promise<Record<string, string>> => {
    const groups = await toolGroups(root)
    const minted = await Promise.all(input.grants.filter((grant) => groups.includes(grant.group)).map((grant) => grant.mint(root)))
    return Object.assign(workspaceRuntimeMcpToolGroupsEnv(groups), ...minted)
  }
}

/** The first-party tool groups one cloud root's project has on, which its runtime and its session hosts' sessions are offered alike. */
export function createCloudRootToolGroups(input: Pick<CloudRootEnvironmentInput, "activations" | "builtIn">) {
  return async (root: CloudRootIdentity): Promise<string[]> => {
    const enabled = await Promise.all(input.builtIn.groups.map(async (group) =>
      (await groupEnabled(input, root, group)) ? group.id : undefined,
    ))
    return enabled.filter((group): group is string => group !== undefined)
  }
}

async function groupEnabled(
  input: Pick<CloudRootEnvironmentInput, "activations" | "builtIn">,
  root: CloudRootIdentity,
  group: BuiltinToolGroup,
): Promise<boolean> {
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
  })
}

/**
 * Whether one root's project has a group on right now, read exactly as the
 * launch environment reads it: as the workspace's recorded owner, for the
 * harness the runtime serves. The renewal route and the switch's withdrawal
 * both ask this so a grant lives by the same reading it was launched under.
 * A build whose first-party server registers no such group answers off.
 */
export function createBuiltinGroupReader(input: Pick<CloudRootEnvironmentInput, "activations" | "builtIn">, groupId: string) {
  const group = input.builtIn.groups.find((candidate) => candidate.id === groupId)
  return async (root: CloudRootIdentity): Promise<boolean> => group !== undefined && (await groupEnabled(input, root, group))
}

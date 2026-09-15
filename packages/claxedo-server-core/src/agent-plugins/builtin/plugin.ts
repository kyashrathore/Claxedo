import { selectActivationAuthority } from "../activation/effective"
import type { EffectiveActivationInput } from "../activation/types"
import { SUPPORTED_AGENT_PLUGIN_HARNESSES, type AgentPluginHarnessId } from "../runtime/harness-registry"

/**
 * The first-party MCP server, as the Marketplace sees it.
 *
 * It is in every deployment's catalog and comes from no source: there is no
 * tree to acquire, no digest to pin and no way to remove it, because the code
 * that serves it is the product. What a user decides about it is which of its
 * tool groups their project may call.
 */
export const BUILTIN_AGENT_PLUGIN_ID = "claxedo"

const GROUP_SEPARATOR = ":"

/**
 * A tool group is its own activation subject.
 *
 * Activation selects a plugin instance for a harness; it has never selected
 * one server out of a plugin. Naming each group as its own instance is
 * therefore the only shape a per-group switch can have without a second
 * activation path beside the one every other plugin uses.
 */
export function builtinPluginInstanceId(groupId: string): string {
  return `${BUILTIN_AGENT_PLUGIN_ID}${GROUP_SEPARATOR}${groupId}`
}

export function builtinToolGroupId(pluginInstanceId: string): string | undefined {
  const [family, ...rest] = pluginInstanceId.split(GROUP_SEPARATOR)
  if (family !== BUILTIN_AGENT_PLUGIN_ID || rest.length !== 1 || !rest[0]) return undefined
  return rest[0]
}

export function isBuiltinPluginInstanceId(pluginInstanceId: string): boolean {
  return builtinToolGroupId(pluginInstanceId) !== undefined
}

/**
 * The catalog row's own name, which every mutation route must refuse.
 *
 * The row is one card over eight activation subjects, so `claxedo` names no
 * row any store can write. Accepted, it would land in the sourced branch and
 * either fail looking for a source that does not exist or write a row nothing
 * reads — which is how a client's whole-plugin button reported a change that
 * never happened.
 */
export function isBuiltinFamilyName(pluginInstanceId: string): boolean {
  return pluginInstanceId === BUILTIN_AGENT_PLUGIN_ID
}

/**
 * The group whose consent the Tasks capability is.
 *
 * Named here rather than beside the minter because both the minter and the
 * self-hosted grant have to agree with the default below, and the two of them
 * sit in different deployments.
 */
export const BUILTIN_TASKS_TOOL_GROUP = "tasks"

/**
 * The group whose consent the owner grant is: a root that may start
 * subagents is a root whose runtime may act as the workspace's owner.
 */
export const BUILTIN_SUBAGENTS_TOOL_GROUP = "subagents"

/**
 * How far a group's tools reach, as its registration declares it.
 *
 * Mirrors the serving package's own vocabulary and is carried here as data,
 * because this package must not depend on the MCP server it describes.
 */
export type BuiltinToolGroupReach = "runtime" | Readonly<{ service: string }> | "account"

/** One group as the serving code declares it: its name, its reach and the tools it registers. */
export type BuiltinToolGroup = Readonly<{
  id: string
  reach: BuiltinToolGroupReach
  tools: readonly string[]
}>

/**
 * What a deployment has to say about itself before the defaults can be read.
 *
 * Only one thing varies: whether the documents a session reads are served by
 * this process or by the account, because that is the difference between a
 * group that reaches no further than the machine already running the session
 * and one that reaches the user's whole account.
 */
export type BuiltinDeployment = Readonly<{
  inProcessServices: readonly string[]
}>

/**
 * What a project gets before anyone has decided anything.
 *
 * Every group but two is served by the runtime the session is already running
 * in, so enabling it grants nothing the session does not already have. Tasks
 * leaves the project and carries a minted capability, so it is a decision the
 * user makes rather than one they inherit. Documents is the same decision
 * wherever the documents service is the account's rather than this process's.
 */
export function builtinGroupDefault(group: BuiltinToolGroup, deployment: BuiltinDeployment): boolean {
  if (group.reach === "runtime") return true
  if (group.reach === "account") return false
  return deployment.inProcessServices.includes(group.reach.service)
}

export type BuiltinActivationInput = Readonly<{
  group: BuiltinToolGroup
  harnessId: AgentPluginHarnessId
  deployment: BuiltinDeployment
}> & (
  | Readonly<{ mode: "signed"; projectOverride?: boolean; userDefault?: boolean; organizationDefault?: true }>
  | Readonly<{ mode: "unsigned"; machineOverride?: boolean }>
)

/**
 * Whether one group is on for one project.
 *
 * The same precedence every plugin is resolved by, with the deployment default
 * standing in for the Claxedo default an ordinary plugin's row carries, and
 * without the artifact step: there is no artifact, so a group a user turned on
 * is on rather than visibly desired and unavailable.
 */
export function resolveBuiltinGroupActivation(input: BuiltinActivationInput): boolean {
  const identity = {
    pluginInstanceId: builtinPluginInstanceId(input.group.id),
    harnessId: input.harnessId,
    claxedoDefault: builtinGroupDefault(input.group, input.deployment),
    pins: {},
  }
  const resolved: EffectiveActivationInput = input.mode === "signed"
    ? {
        ...identity,
        mode: "signed",
        ...(input.projectOverride === undefined ? {} : { projectOverride: input.projectOverride }),
        ...(input.userDefault === undefined ? {} : { userDefault: input.userDefault }),
        ...(input.organizationDefault === undefined ? {} : { organizationDefault: input.organizationDefault }),
      }
    : {
        ...identity,
        mode: "unsigned",
        ...(input.machineOverride === undefined ? {} : { machineOverride: input.machineOverride }),
      }
  return selectActivationAuthority(resolved).enabled
}

export type BuiltinGroupView = Readonly<{
  id: string
  pluginInstanceId: string
  enabled: boolean
  tools: readonly string[]
}>

/**
 * The catalog row, in the shape every other candidate is read in.
 *
 * The directory decodes it with the same reader as a sourced plugin; the two
 * fields it does not share — `builtIn` and `groups` — are what the pane needs
 * to offer switches instead of an install button.
 *
 * The harness rows say only that the built-in is present and whether anything
 * is on: the decisions live on the groups, each of which is its own activation
 * subject, and a harness has never been a thing the first-party server is
 * projected into.
 */
export function builtinCatalogEntry(input: {
  groups: readonly BuiltinToolGroup[]
  deployment: BuiltinDeployment
  /** Whether one group is on for one harness, as this deployment's store resolves it. */
  enabled: (group: BuiltinToolGroup, harnessId: AgentPluginHarnessId) => boolean
}) {
  const groups: BuiltinGroupView[] = input.groups.map((group) => ({
    id: group.id,
    pluginInstanceId: builtinPluginInstanceId(group.id),
    enabled: SUPPORTED_AGENT_PLUGIN_HARNESSES.every((harnessId) => input.enabled(group, harnessId)),
    tools: group.tools,
  }))
  const harnesses = Object.fromEntries(SUPPORTED_AGENT_PLUGIN_HARNESSES.map((harnessId) => [harnessId, {
    explicit: null,
    projectOverride: null,
    userDefault: null,
    organizationDefault: false,
    claxedoDefault: true,
    effective: {
      status: "ready" as const,
      effective: input.groups.some((group) => input.enabled(group, harnessId)),
      winner: "claxedo" as const,
    },
  }]))
  return {
    pluginInstanceId: BUILTIN_AGENT_PLUGIN_ID,
    builtIn: true,
    groups,
    sourceId: null,
    sourceKind: null,
    source: null,
    icon: { kind: "monogram" as const, text: "CX" },
    skills: [],
    sourceRevision: null,
    relativePath: null,
    candidateDigest: null,
    retainedDigest: null,
    sourceAvailable: false,
    updateAvailable: false,
    manifest: {
      name: BUILTIN_AGENT_PLUGIN_ID,
      description: "Claxedo's own tools, served by the process that runs your sessions.",
    },
    mcpServers: groups.map((group) => ({
      name: group.id,
      type: "streamable-http" as const,
      authentication: { state: "local" as const },
    })),
    componentDiagnostics: [],
    harnesses,
  }
}

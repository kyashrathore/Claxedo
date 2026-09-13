import { selectActivationAuthority } from "../activation/effective"
import type { EffectiveActivationInput } from "../activation/types"
import type { AgentPluginHarnessId } from "../runtime/harness-registry"

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

/** One group as the serving code declares it: its name and the tools it registers. */
export type BuiltinToolGroup = Readonly<{
  id: string
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
  documentsInProcess: boolean
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
export function builtinGroupDefault(groupId: string, deployment: BuiltinDeployment): boolean {
  if (groupId === "tasks") return false
  if (groupId === "documents") return deployment.documentsInProcess
  return true
}

export type BuiltinActivationInput = Readonly<{
  groupId: string
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
    pluginInstanceId: builtinPluginInstanceId(input.groupId),
    harnessId: input.harnessId,
    claxedoDefault: builtinGroupDefault(input.groupId, input.deployment),
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

export type BuiltinHarnessActivationView = Readonly<{
  projectOverride: boolean | null
  userDefault: boolean | null
  organizationDefault: boolean
  claxedoDefault: boolean
  effective: { status: "ready"; effective: boolean; winner: string }
}>

/**
 * The catalog row, in the shape every other candidate is read in.
 *
 * The directory renders it with the same decoder as a sourced plugin; the two
 * fields it does not share — `builtIn` and `groups` — are what the pane needs
 * to show switches instead of an install button.
 */
export function builtinCandidateView(input: {
  groups: readonly BuiltinGroupView[]
  harnesses: Readonly<Record<AgentPluginHarnessId, BuiltinHarnessActivationView>>
}) {
  return {
    pluginInstanceId: BUILTIN_AGENT_PLUGIN_ID,
    builtIn: true,
    groups: input.groups,
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
    mcpServers: input.groups.map((group) => ({
      name: group.id,
      type: "streamable-http" as const,
      authentication: { state: "local" as const },
    })),
    componentDiagnostics: [],
    harnesses: input.harnesses,
  }
}

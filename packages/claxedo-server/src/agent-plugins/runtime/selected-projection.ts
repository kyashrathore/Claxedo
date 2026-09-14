import type { AgentPluginArtifactPin } from "@claxedo/server-core/agent-plugins/activation/store"
import type { AgentPluginArtifactStore } from "@claxedo/server-core/agent-plugins/artifacts/types"
import {
  agentPluginSelectionHash,
  type AgentPluginExecutionSelection,
  type AgentPluginSelectedSelection,
} from "@claxedo/server-core/agent-plugins/runtime/execution-selection"
import {
  agentPluginHarnessDescriptor,
  SUPPORTED_AGENT_PLUGIN_HARNESSES,
} from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import type { SignedAgentPluginRuntimeSnapshot } from "./provision"

export class AgentPluginSelectionError extends Error {
  constructor(
    readonly code: "unresolved" | "ambiguous" | "collision" | "artifact-unavailable",
    message: string,
  ) {
    super(message)
    this.name = "AgentPluginSelectionError"
  }
}

/**
 * The artifact a plugin instance is entitled to, independently of whether the
 * project's defaults have it switched on.
 *
 * An explicit execution selection is not a default: a plugin the user turned
 * off for everyday work is still theirs to run in one isolated root, and a
 * plugin nobody retained for them is not, whatever a preset names. Precedence
 * follows the activation layers so a user's own pinned revision wins over the
 * organization's and Claxedo's.
 */
function authorizedPin(pins: SignedAgentPluginRuntimeSnapshot["plugins"][number]["pins"]) {
  return pins.user ?? pins.organization ?? pins.claxedo
}

type AuthorizedArtifact = {
  pluginInstanceId: string
  pin: AgentPluginArtifactPin
  pluginName: string
  skills: readonly string[]
}

async function authorizedArtifacts(
  snapshot: SignedAgentPluginRuntimeSnapshot,
  artifacts: AgentPluginArtifactStore,
): Promise<AuthorizedArtifact[]> {
  const rows: AuthorizedArtifact[] = []
  for (const plugin of snapshot.plugins) {
    const pin = authorizedPin(plugin.pins)
    if (!pin) continue
    const artifact = await artifacts.get(pin.digest)
    if (!artifact) {
      throw new AgentPluginSelectionError(
        "artifact-unavailable",
        `Retained Agent Plugin artifact ${pin.digest} is unavailable for ${plugin.pluginInstanceId}`,
      )
    }
    rows.push({
      pluginInstanceId: plugin.pluginInstanceId,
      pin,
      pluginName: artifact.plugin.manifest.name,
      skills: artifact.plugin.skills.map((skill) => skill.name),
    })
  }
  return rows
}

function one<T>(matches: readonly T[], missing: string, ambiguous: string): T {
  if (matches.length === 0) throw new AgentPluginSelectionError("unresolved", missing)
  if (matches.length > 1) throw new AgentPluginSelectionError("ambiguous", ambiguous)
  return matches[0]
}

/**
 * Refuse a selection a target harness would silently collapse.
 *
 * Only the flat-namespace harnesses can lose a skill this way, but the
 * projection is one capability set for the whole root — its children run on
 * whichever harness they ask for — so a pair that any supported harness cannot
 * keep apart is refused for all of them rather than becoming a root whose
 * inventory depends on which harness opened it.
 */
function assertNoSkillCollision(
  selections: readonly AgentPluginSelectedSelection[],
  skillsOf: (selection: AgentPluginSelectedSelection) => readonly string[],
) {
  const flat = SUPPORTED_AGENT_PLUGIN_HARNESSES
    .filter((harnessId) => agentPluginHarnessDescriptor(harnessId).skillNamespace === "flat")
  for (const harnessId of flat) {
    const owners = new Map<string, string>()
    for (const selection of selections) {
      if (!selection.harnessIds.includes(harnessId)) continue
      for (const skill of skillsOf(selection)) {
        const previous = owners.get(skill)
        if (previous && previous !== selection.pluginInstanceId) {
          throw new AgentPluginSelectionError(
            "collision",
            `${harnessId} cannot run two skills named ${skill}, supplied by ${previous} and ${selection.pluginInstanceId}`,
          )
        }
        owners.set(skill, selection.pluginInstanceId)
      }
    }
  }
}

/**
 * The exact projection one explicit selection resolves to, and its hash.
 *
 * Nothing here reads or writes an activation default: the answer is built from
 * the retained artifacts the snapshot says this user is entitled to, so
 * running a preset in an isolated root leaves the project's everyday
 * configuration exactly as it was. An empty selection resolves to no
 * selections at all and keeps its own hash, which is how an empty cloud root
 * stays distinguishable from a root that never asked for one.
 */
export async function selectedAgentPluginProjection(input: {
  snapshot: SignedAgentPluginRuntimeSnapshot
  artifacts: AgentPluginArtifactStore
  selection: AgentPluginExecutionSelection
}): Promise<{ selections: AgentPluginSelectedSelection[]; selectionHash: string }> {
  const authorized = await authorizedArtifacts(input.snapshot, input.artifacts)
  const harnessIds = [...SUPPORTED_AGENT_PLUGIN_HARNESSES]

  const wholePlugins = new Map<string, AuthorizedArtifact>()
  for (const reference of input.selection.plugins) {
    const matches = authorized.filter((candidate) =>
      candidate.pin.sourceId === reference.sourceId && candidate.pluginName === reference.pluginName)
    const match = one(
      matches,
      `Plugin ${reference.pluginName} is not installed from ${reference.sourceId} for this project`,
      `Source ${reference.sourceId} supplies more than one plugin named ${reference.pluginName}`,
    )
    wholePlugins.set(match.pluginInstanceId, match)
  }

  const guidanceOnly = new Map<string, { artifact: AuthorizedArtifact; skills: Set<string> }>()
  for (const reference of input.selection.skills) {
    const matches = authorized.filter((candidate) =>
      candidate.pin.sourceId === reference.sourceId && candidate.skills.includes(reference.skillName))
    const match = one(
      matches,
      `Skill ${reference.skillName} is not installed from ${reference.sourceId} for this project`,
      `Source ${reference.sourceId} supplies more than one skill named ${reference.skillName}`,
    )
    // The plugin already contributes every skill it bundles, so naming one of
    // them directly adds nothing and must not turn into a second selection of
    // the same artifact.
    if (wholePlugins.has(match.pluginInstanceId)) continue
    const existing = guidanceOnly.get(match.pluginInstanceId)
    if (existing) existing.skills.add(reference.skillName)
    else guidanceOnly.set(match.pluginInstanceId, { artifact: match, skills: new Set([reference.skillName]) })
  }

  const selections: AgentPluginSelectedSelection[] = [
    ...[...wholePlugins.values()].map((artifact) => ({
      pluginInstanceId: artifact.pluginInstanceId,
      artifactDigest: artifact.pin.digest,
      harnessIds: [...harnessIds],
      contribution: { kind: "plugin" as const },
    })),
    ...[...guidanceOnly.values()].map((entry) => ({
      pluginInstanceId: entry.artifact.pluginInstanceId,
      artifactDigest: entry.artifact.pin.digest,
      harnessIds: [...harnessIds],
      contribution: { kind: "skills" as const, skills: [...entry.skills].toSorted() },
    })),
  ].toSorted((a, b) => a.pluginInstanceId.localeCompare(b.pluginInstanceId))

  const bundled = new Map(authorized.map((artifact) => [artifact.pluginInstanceId, artifact.skills]))
  assertNoSkillCollision(selections, (selection) =>
    selection.contribution.kind === "plugin"
      ? bundled.get(selection.pluginInstanceId) ?? []
      : selection.contribution.skills)

  return { selections, selectionHash: await agentPluginSelectionHash(selections) }
}

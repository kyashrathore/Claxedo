import type { ArtifactDigest } from "../activation/types"
import type { RetainedAgentPluginArtifact } from "../artifacts/types"
import { agentPluginTree, type AgentPluginTree } from "../artifacts/tree"
import type { AgentPluginHarnessId } from "./harness-registry"

/**
 * Catalog identity of what an execution explicitly asked for. A plugin is
 * named by the manifest name inside its collection, never by a repository
 * path, so a collection that moves a plugin's directory does not silently
 * change what a saved execution resolves to.
 */
export type AgentPluginExecutionSelection = {
  plugins: readonly { sourceId: string; pluginName: string }[]
  skills: readonly { sourceId: string; skillName: string }[]
}

/**
 * What one retained artifact contributes to a selected execution.
 *
 * `plugin` is the whole plugin: its bundled skills and its declared MCP
 * servers. `skills` is guidance alone — the named skills and nothing else,
 * because selecting a skill is not a request for the tools of whatever plugin
 * happens to ship it.
 */
export type AgentPluginSelectedContribution =
  | { kind: "plugin" }
  | { kind: "skills"; skills: readonly string[] }

export type AgentPluginSelectedSelection = {
  pluginInstanceId: string
  artifactDigest: ArtifactDigest
  harnessIds: AgentPluginHarnessId[]
  contribution: AgentPluginSelectedContribution
}

function contributionKey(contribution: AgentPluginSelectedContribution) {
  return contribution.kind === "plugin" ? ["plugin"] : ["skills", [...contribution.skills].toSorted()]
}

/**
 * The identity of a resolved projection, carried through preparation,
 * coalescing, apply and the runtime's receipt.
 *
 * It is a function of what will actually be materialized and of nothing else,
 * so two selections that resolve to the same artifacts and the same
 * contributions share one projection, while the same activation revision under
 * a different selection can never be mistaken for it.
 */
export async function agentPluginSelectionHash(
  selections: readonly AgentPluginSelectedSelection[],
): Promise<string> {
  const canonical = selections
    .map((selection) => [
      selection.pluginInstanceId,
      selection.artifactDigest,
      [...selection.harnessIds].toSorted(),
      contributionKey(selection.contribution),
    ])
    .toSorted((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)
  const bytes = new TextEncoder().encode(JSON.stringify(canonical))
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function skillPrefix(skillName: string) {
  return `skills/${skillName}/`
}

/**
 * The bytes and the validated view one contribution materializes.
 *
 * Pruning happens here, once, rather than in each harness adapter: bytes an
 * adapter never receives cannot reach a harness that discovers plugin content
 * by walking the directory it was handed. The retained digest still describes
 * the whole artifact, which is why this returns a view and not an artifact —
 * a pruned tree does not hash to the digest it came from, and delivery
 * verifies that digest before this runs.
 */
export function agentPluginContributionView(
  artifact: Pick<RetainedAgentPluginArtifact, "digest" | "tree" | "plugin">,
  contribution: AgentPluginSelectedContribution,
): Pick<RetainedAgentPluginArtifact, "tree" | "plugin"> {
  if (contribution.kind === "plugin") return { tree: artifact.tree, plugin: artifact.plugin }
  const kept = new Set(contribution.skills)
  for (const name of kept) {
    if (!artifact.plugin.skills.some((skill) => skill.name === name)) {
      throw new Error(`Artifact ${artifact.digest} has no skill named ${name}`)
    }
  }
  const entries = artifact.tree.entries.filter((entry) => {
    if (entry.path === "mcp.json") return false
    if (entry.path === "skills") return kept.size > 0
    if (!entry.path.startsWith("skills/")) return true
    return [...kept].some((name) => entry.path === `skills/${name}` || entry.path.startsWith(skillPrefix(name)))
  })
  const tree: AgentPluginTree = agentPluginTree(entries)
  return {
    tree,
    plugin: {
      ...artifact.plugin,
      skills: artifact.plugin.skills.filter((skill) => kept.has(skill.name)),
      mcp: { status: "absent", servers: [] },
    },
  }
}

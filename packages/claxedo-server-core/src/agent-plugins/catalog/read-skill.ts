import { treeText } from "../artifacts/tree"
import type { RetainedAgentPluginArtifact } from "../artifacts/types"

export type AgentPluginSkillDocument = {
  name: string
  description: string
  markdown: string
}

/**
 * Reads one skill's SKILL.md out of a retained artifact tree — never a source.
 *
 * The requested name selects an already-validated skill entry; it is never
 * joined into a path. A traversal attempt (`..`, `a/b`, an absolute path) can
 * only fail to match a validated skill directory name, so it returns nothing.
 */
export function readRetainedSkill(
  artifact: Pick<RetainedAgentPluginArtifact, "tree" | "plugin"> | undefined,
  skill: string,
): AgentPluginSkillDocument | undefined {
  const entry = artifact?.plugin.skills.find((candidate) => candidate.name === skill)
  if (!artifact || !entry) return undefined
  const markdown = treeText(artifact.tree, `${entry.path}/SKILL.md`)
  if (markdown === undefined) return undefined
  return { name: entry.name, description: entry.description, markdown }
}

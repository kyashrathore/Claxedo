import { treeText } from "../artifacts/tree"
import type { AgentPluginCatalogCandidate, AgentPluginSkill } from "./types"
import type { RetainedAgentPluginArtifact } from "../artifacts/types"

export type AgentPluginSkillDocument = {
  name: string
  description: string
  markdown: string
}

type SkillTree = {
  tree: RetainedAgentPluginArtifact["tree"]
  skills: readonly AgentPluginSkill[]
}

/**
 * Reads one skill's SKILL.md out of a plugin tree.
 *
 * The requested name selects an already-validated skill entry; it is never
 * joined into a path. A traversal attempt (`..`, `a/b`, an absolute path) can
 * only fail to match a validated skill directory name, so it returns nothing.
 */
export function readSkillDocument(
  source: SkillTree | undefined,
  skill: string,
): AgentPluginSkillDocument | undefined {
  const entry = source?.skills.find((candidate) => candidate.name === skill)
  if (!source || !entry) return undefined
  const markdown = treeText(source.tree, `${entry.path}/SKILL.md`)
  if (markdown === undefined) return undefined
  return { name: entry.name, description: entry.description, markdown }
}

/** Retained copy first (what harnesses run), then the cached catalog tree. */
export function readPluginSkill(input: {
  retained?: Pick<RetainedAgentPluginArtifact, "tree" | "plugin">
  candidate?: Pick<AgentPluginCatalogCandidate, "tree" | "skills">
  skill: string
}) {
  return readSkillDocument(
    input.retained ? { tree: input.retained.tree, skills: input.retained.plugin.skills } : undefined,
    input.skill,
  ) ?? readSkillDocument(
    input.candidate ? { tree: input.candidate.tree, skills: input.candidate.skills } : undefined,
    input.skill,
  )
}

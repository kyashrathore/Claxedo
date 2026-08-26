import path from "path"
import type { MaterializedAgentExtensionScope, HarnessTarget } from "../types"
import type { MaterializedRuntimeRecord } from "../materialization"
import { linkOrCopyOwnedDirectory } from "../materialization"
import { assertSafePathSegment } from "../fs-safe"

export function skillTargetDir(input: {
  runner: HarnessTarget
  scope: MaterializedAgentExtensionScope
  name: string
  projectDir?: string
  homeDir?: string
}) {
  // Defense in depth at the path-construction point: the skill name may have
  // traveled from repo-controlled desired state (package_name/id), not just
  // from a directory listing.
  assertSafePathSegment(input.name, "Skill name")
  if (input.scope === "project") {
    if (!input.projectDir) throw new Error("projectDir is required for project skill materialization")
    if (input.runner === "claude") return path.join(input.projectDir, ".claude", "skills", input.name)
    if (input.runner === "codex") return path.join(input.projectDir, ".agents", "skills", input.name)
    if (input.runner === "opencode") return path.join(input.projectDir, ".opencode", "skills", input.name)
    return path.join(input.projectDir, ".cursor", "skills", input.name)
  }
  if (!input.homeDir) throw new Error("homeDir is required for machine skill materialization")
  if (input.runner === "claude") return path.join(input.homeDir, ".claude", "skills", input.name)
  if (input.runner === "codex") return path.join(input.homeDir, ".codex", "skills", input.name)
  if (input.runner === "opencode") return path.join(input.homeDir, ".config", "opencode", "skills", input.name)
  return path.join(input.homeDir, ".cursor", "skills", input.name)
}

export async function materializeStandaloneSkill(input: {
  skillDir: string
  name: string
  runner: HarnessTarget
  scope: MaterializedAgentExtensionScope
  ownerId: string
  projectDir?: string
  homeDir?: string
  record?: MaterializedRuntimeRecord
  replaceOwned?: boolean
  symlink?: (source: string, target: string, type: "dir") => Promise<void>
}) {
  const result = await linkOrCopyOwnedDirectory({
    sourceDir: input.skillDir,
    targetDir: skillTargetDir(input),
    ownerId: input.ownerId,
    record: input.record,
    ...(input.replaceOwned ? { replaceOwned: input.replaceOwned } : {}),
    ...(input.symlink ? { symlink: input.symlink } : {}),
  })
  return {
    runner: input.runner,
    component: input.name,
    type: "skill" as const,
    status: result.status,
    ...(result.reason ? { reason: result.reason } : {}),
    path: result.path,
  }
}

import fs from "node:fs/promises"
import path from "node:path"
import type { MachineSkill, MachineSkillHarnessId } from "./types"

/** A skill directory is one whose immediate children each hold this file. */
const MARKER = "SKILL.md"

type SkillRoot = { harnessId: MachineSkillHarnessId; root: string }

/**
 * Where each harness keeps the skills a user installed for it machine-wide.
 *
 * Claxedo materializes its own plugins into per-generation directories it hands
 * a harness over a flag, never into these, so everything found here is the
 * user's own.
 */
function skillRoots(input: { home: string; codexHome?: string }): SkillRoot[] {
  const codexHome = input.codexHome ?? path.join(input.home, ".codex")
  return [
    { harnessId: "claude", root: path.join(input.home, ".claude", "skills") },
    { harnessId: "opencode", root: path.join(input.home, ".config", "opencode", "skills") },
    { harnessId: "codex", root: path.join(codexHome, "skills") },
    { harnessId: "cursor", root: path.join(input.home, ".cursor", "skills") },
    { harnessId: "agents", root: path.join(input.home, ".agents", "skills") },
  ]
}

async function isSkillDirectory(candidate: string): Promise<boolean> {
  try {
    if (!(await fs.lstat(candidate)).isDirectory()) return false
    return (await fs.stat(path.join(candidate, MARKER))).isFile()
  } catch {
    return false
  }
}

/**
 * D3 "Personal" skill discovery: `SKILL.md` folders the user installed for a
 * harness outside Claxedo. Read-only and never throws — an absent or
 * unreadable root contributes nothing rather than failing the response.
 *
 * Ordered by harness then name so a re-read does not reshuffle the rows;
 * `localeCompare` is avoided so the order does not depend on the machine's
 * locale.
 */
export async function readMachineSkills(input: { home: string; codexHome?: string }): Promise<MachineSkill[]> {
  const found = await Promise.all(skillRoots(input).map(async ({ harnessId, root }) => {
    let names: string[]
    try {
      names = await fs.readdir(root)
    } catch {
      return []
    }
    const skills: MachineSkill[] = []
    for (const name of names.sort()) {
      if (name.startsWith(".")) continue
      const skillRoot = path.join(root, name)
      if (!(await isSkillDirectory(skillRoot))) continue
      skills.push({ name, harnessId, root: skillRoot })
    }
    return skills
  }))
  return found.flat()
}

import { Skill } from "@opencode-ai/schema/skill"
import { promises as fs } from "node:fs"
import path from "node:path"
import { decodeSkillFrontmatter } from "@claxedo/helpers/skill-frontmatter"

function missingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

export async function loadSkills(directories: readonly string[]): Promise<Skill.Info[]> {
  const skills = new Map<string, Skill.Info>()
  for (const directory of directories) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (missingFile(error)) return []
      throw error
    })
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue
      const location = path.join(directory, entry.name, "SKILL.md")
      const text = await fs.readFile(location, "utf8").catch((error: unknown) => {
        if (missingFile(error)) return undefined
        throw error
      })
      if (text === undefined) continue
      skills.set(entry.name, parseSkill(entry.name, location, text))
    }
  }
  return [...skills.values()]
}

export function parseSkill(id: string, location: string, text: string): Skill.Info {
  const { fields, content } = decodeSkillFrontmatter(text)
  return Skill.Info.make({
    id: Skill.ID.make(id),
    name: Skill.Name.make(fields?.name || id),
    ...(fields?.description ? { description: fields.description } : {}),
    location: Skill.Info.fields.location.make(location),
    content,
  })
}

import { Skill } from "@opencode-ai/schema/skill"
import { promises as fs } from "node:fs"
import path from "node:path"
import { decodeSkillFrontmatter } from "@claxedo/helpers/skill-frontmatter"

export async function loadSkills(directories: readonly string[]): Promise<Skill.Info[]> {
  const skills = new Map<string, Skill.Info>()
  for (const directory of directories) {
    const id = path.basename(directory)
    const location = path.join(directory, "SKILL.md")
    const text = await fs.readFile(location, "utf8")
    skills.set(id, parseSkill(id, location, text))
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

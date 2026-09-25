import { Skill } from "@opencode-ai/schema/skill"
import { promises as fs } from "node:fs"
import path from "node:path"

export async function loadSkills(directories: readonly string[]): Promise<Skill.Info[]> {
  const skills = new Map<string, Skill.Info>()
  for (const directory of directories) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue
      const location = path.join(directory, entry.name, "SKILL.md")
      const text = await fs.readFile(location, "utf8").catch(() => undefined)
      if (text === undefined) continue
      skills.set(entry.name, parseSkill(entry.name, location, text))
    }
  }
  return [...skills.values()]
}

export function parseSkill(id: string, location: string, text: string): Skill.Info {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  const frontmatter: Record<string, string> = {}
  for (const line of (match?.[1] ?? "").split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (field) frontmatter[field[1]] = field[2].trim().replace(/^(["'])(.*)\1$/, "$2")
  }
  return Skill.Info.make({
    id: Skill.ID.make(id),
    name: Skill.Name.make(frontmatter.name || id),
    ...(frontmatter.description ? { description: frontmatter.description } : {}),
    location: Skill.Info.fields.location.make(location),
    content: match ? match[2] : text,
  })
}

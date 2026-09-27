import { parse as parseYaml } from "yaml"
import { isRecord } from "./guards"

export type SkillFrontmatter = Record<string, unknown> & { name?: string; description?: string }

export function decodeSkillFrontmatter(text: string): { fields?: SkillFrontmatter; content: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) return { content: text }
  const fields: unknown = parseYaml(match[1]!)
  if (!isRecord(fields)) throw new Error("Skill frontmatter must be a YAML mapping")
  for (const key of ["name", "description"]) {
    if (fields[key] !== undefined && typeof fields[key] !== "string") throw new Error(`Skill ${key} must be a string`)
  }
  return { fields: fields as SkillFrontmatter, content: text.slice(match[0].length) }
}

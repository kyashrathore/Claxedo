import type { Context } from "@earendil-works/chord"
import { section, type PromptSection } from "@earendil-works/pi-durable"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import type { SkillRoot } from "../../contract"

const GUIDE = "Each skill below is a folder of instructions. When a task matches a skill's description, read its SKILL.md with the read tool before acting."

const xmlText = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

function frontmatter(text: string, field: string): string | undefined {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]
  const line = head?.split(/\r?\n/).find((entry) => entry.startsWith(`${field}:`))
  return line?.slice(field.length + 1).trim().replace(/^["']|["']$/g, "") || undefined
}

async function skillEntry(env: ExecutionEnv, root: SkillRoot, name: string, context: Context): Promise<string | undefined> {
  const location = await env.joinPath([root.root, "skills", name, "SKILL.md"], context)
  if (!location.ok) return undefined
  const text = await env.readTextFile(location.value, context)
  const description = text.ok ? frontmatter(text.value, "description") ?? "" : ""
  return `<skill>\n<name>${xmlText(frontmatter(text.ok ? text.value : "", "name") ?? name)}</name>\n` +
    `<description>${xmlText(description)}</description>\n<location>${xmlText(location.value)}</location>\n</skill>`
}

export function piSkillsSection(roots: () => readonly SkillRoot[]): PromptSection {
  return section("available_skills", async (input, context) => {
    const env = input.env
    const listed = roots().flatMap((root) => root.skillNames.map((name) => ({ root, name })))
    if (!env || !listed.length) return undefined
    const skills = await Promise.all(listed.map(({ root, name }) => skillEntry(env, root, name, context)))
    return [GUIDE, ...skills.filter((entry) => entry !== undefined)].join("\n")
  })
}

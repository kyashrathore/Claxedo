import { expect, test } from "bun:test"
import { parseSkill } from "./skill-info"

test("OpenCode receives folded YAML skill descriptions and the intact body", () => {
  expect(parseSkill("review", "/skills/review/SKILL.md", [
    "---", "name: review", "description: >-", "  Review: changes", "  carefully", "---", "# Steps", "",
  ].join("\n"))).toMatchObject({ name: "review", description: "Review: changes carefully", content: "# Steps\n" })
})

test("OpenCode receives literal descriptions and decoded quoted names with CRLF frontmatter", () => {
  expect(parseSkill("review", "/skills/review/SKILL.md", [
    "---", 'name: "Code \\"review\\""', "description: |-", "  First line", "  Second line", "---", "# Steps", "",
  ].join("\r\n"))).toMatchObject({ name: 'Code "review"', description: "First line\nSecond line", content: "# Steps\r\n" })
})

test("parseSkill reads the frontmatter the engine reads and keeps the body", () => {
  const skill = parseSkill("review", "/skills/review/SKILL.md", '---\nname: "Code review"\ndescription: Review code\n---\n# Steps\n')
  expect(skill as Record<string, unknown>).toEqual({ id: "review", name: "Code review", description: "Review code", location: "/skills/review/SKILL.md", content: "# Steps\n" })
  expect(parseSkill("bare", "/skills/bare/SKILL.md", "no frontmatter")).toMatchObject({ id: "bare", name: "bare", content: "no frontmatter" })
})

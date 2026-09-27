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

import { expect, test } from "bun:test"
import { decodeSkillFrontmatter } from "./skill-frontmatter"

test("decodes YAML metadata while preserving the body bytes", () => {
  expect(decodeSkillFrontmatter("---\r\nname: review\r\ndescription: >-\r\n  Review: changes\r\n  carefully\r\nmetadata:\r\n  author: team\r\n---\r\nBody\r\n")).toEqual({
    fields: { name: "review", description: "Review: changes carefully", metadata: { author: "team" } }, content: "Body\r\n",
  })
  expect(decodeSkillFrontmatter("---\nname: review\n---")).toEqual({ fields: { name: "review" }, content: "" })
})

test("leaves documents without delimited frontmatter intact", () => {
  for (const text of ["Body", "---\nname: review\nBody", "---\nname: review\n---not a delimiter\nBody"]) {
    expect(decodeSkillFrontmatter(text)).toEqual({ content: text })
  }
})

test("rejects malformed YAML and invalid skill metadata types", () => {
  for (const yaml of ["name: [", "- review", "name: 42", "description: false", "name: a\nname: b"]) {
    expect(() => decodeSkillFrontmatter(`---\n${yaml}\n---\nBody`)).toThrow()
  }
})

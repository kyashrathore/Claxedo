import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { inspectPluginDirectory } from "../artifacts/node-tree"
import { readPluginSkill, readSkillDocument } from "./read-skill"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

const RETAINED = "---\nname: review\ndescription: Review a diff\n---\n\n# Review\n\nRead the retained copy.\n"
const CATALOG = "---\nname: review\ndescription: Review a diff\n---\n\n# Review\n\nRead the catalog copy.\n"

async function pluginTree(markdown: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-plugin-read-skill-"))
  roots.push(root)
  await fs.writeFile(path.join(root, "plugin.json"), JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "review",
  }))
  await fs.mkdir(path.join(root, "skills", "review"), { recursive: true })
  await fs.writeFile(path.join(root, "skills", "review", "SKILL.md"), markdown)
  await fs.mkdir(path.join(root, "docs"))
  await fs.writeFile(path.join(root, "docs", "SKILL.md"), "not a skill")
  return await inspectPluginDirectory(root)
}

describe("readSkillDocument", () => {
  test("returns SKILL.md verbatim with its validated frontmatter", async () => {
    const artifact = await pluginTree(RETAINED)

    expect(readSkillDocument({ tree: artifact.tree, skills: artifact.plugin.skills }, "review")).toEqual({
      name: "review",
      description: "Review a diff",
      markdown: RETAINED,
    })
  })

  test("refuses a name that is not a validated skill, including a traversal", async () => {
    const artifact = await pluginTree(RETAINED)
    const source = { tree: artifact.tree, skills: artifact.plugin.skills }

    expect(readSkillDocument(source, "missing")).toBeUndefined()
    expect(readSkillDocument(source, "..")).toBeUndefined()
    expect(readSkillDocument(source, "../plugin.json")).toBeUndefined()
    expect(readSkillDocument(source, "../docs")).toBeUndefined()
    expect(readSkillDocument(source, "docs")).toBeUndefined()
    expect(readSkillDocument(source, "skills/review")).toBeUndefined()
  })

  test("reads nothing when no tree is present", () => {
    expect(readSkillDocument(undefined, "review")).toBeUndefined()
  })
})

describe("readPluginSkill", () => {
  test("prefers the retained tree when both copies exist", async () => {
    const retained = await pluginTree(RETAINED)
    const catalog = await pluginTree(CATALOG)

    expect(readPluginSkill({
      retained,
      candidate: { tree: catalog.tree, skills: catalog.plugin.skills },
      skill: "review",
    })?.markdown).toBe(RETAINED)
  })

  test("falls back to the catalog tree when nothing is retained", async () => {
    const catalog = await pluginTree(CATALOG)

    expect(readPluginSkill({
      candidate: { tree: catalog.tree, skills: catalog.plugin.skills },
      skill: "review",
    })?.markdown).toBe(CATALOG)
  })
})

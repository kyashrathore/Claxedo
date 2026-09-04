import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { inspectPluginDirectory } from "../artifacts/node-tree"
import { readRetainedSkill } from "./read-skill"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

const MARKDOWN = "---\nname: review\ndescription: Review a diff\n---\n\n# Review\n\nRead the diff twice.\n"

async function retained() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-plugin-read-skill-"))
  roots.push(root)
  await fs.writeFile(path.join(root, "plugin.json"), JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "review",
  }))
  await fs.mkdir(path.join(root, "skills", "review"), { recursive: true })
  await fs.writeFile(path.join(root, "skills", "review", "SKILL.md"), MARKDOWN)
  await fs.mkdir(path.join(root, "docs"))
  await fs.writeFile(path.join(root, "docs", "SKILL.md"), "not a skill")
  return await inspectPluginDirectory(root)
}

describe("readRetainedSkill", () => {
  test("returns the retained SKILL.md verbatim with its validated frontmatter", async () => {
    const artifact = await retained()

    expect(readRetainedSkill(artifact, "review")).toEqual({
      name: "review",
      description: "Review a diff",
      markdown: MARKDOWN,
    })
  })

  test("refuses a name that is not a validated skill, including a traversal", async () => {
    const artifact = await retained()

    expect(readRetainedSkill(artifact, "missing")).toBeUndefined()
    expect(readRetainedSkill(artifact, "..")).toBeUndefined()
    expect(readRetainedSkill(artifact, "../plugin.json")).toBeUndefined()
    expect(readRetainedSkill(artifact, "../docs")).toBeUndefined()
    expect(readRetainedSkill(artifact, "docs")).toBeUndefined()
    expect(readRetainedSkill(artifact, "skills/review")).toBeUndefined()
  })

  test("reads nothing when no artifact is retained", async () => {
    expect(readRetainedSkill(undefined, "review")).toBeUndefined()
  })
})

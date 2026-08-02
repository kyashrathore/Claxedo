import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { createAgentExtensions } from "./facade"

const root = path.join(os.tmpdir(), `agent-extensions-facade-${randomUUID().slice(0, 8)}`)
const project = path.join(root, "project")
const home = path.join(root, "home")
const data = path.join(root, "data")

describe("Agent Extensions facade", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.mkdir(path.join(project, "packages", "review"), { recursive: true })
    await fs.mkdir(home, { recursive: true })
    await fs.writeFile(path.join(project, "packages", "review", "SKILL.md"), "---\nname: review\n---\n")
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  test("disable, materialize, enable round trip preserves the install", async () => {
    const extensions = createAgentExtensions({ projectDir: project, homeDir: home, dataRoot: data })
    await extensions.installCached({
      packagePath: "packages/review",
      id: "review",
      targets: ["cursor"],
    })

    await extensions.disable({ id: "review" })
    // materialize replays the snapshot over the same state root; a snapshot
    // that dropped disabled installs would erase review here for good.
    await extensions.materialize()

    await expect(fs.readFile(path.join(project, ".agent-extensions", "installed.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      installs: [{ id: "review", enabled: false }],
    })

    const enabled = await extensions.enable({ id: "review" })
    expect(enabled?.materialized.status).toBe("applied")
    await expect(fs.readFile(path.join(project, ".cursor", "skills", "review", "SKILL.md"), "utf8")).resolves.toContain("name: review")
  })

  test("repeated materialize keeps enabled installs and their artifacts", async () => {
    const extensions = createAgentExtensions({ projectDir: project, homeDir: home, dataRoot: data })
    await extensions.installCached({
      packagePath: "packages/review",
      id: "review",
      targets: ["cursor"],
    })

    await extensions.materialize()
    await extensions.materialize()

    await expect(fs.readFile(path.join(project, ".agent-extensions", "installed.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      installs: [{ id: "review", enabled: true }],
    })
    await expect(fs.readFile(path.join(project, ".cursor", "skills", "review", "SKILL.md"), "utf8")).resolves.toContain("name: review")
  })
})

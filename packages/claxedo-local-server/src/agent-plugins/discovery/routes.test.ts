import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { afterEach, describe, expect, test } from "vitest"
import { MachineInstalledDiscoveryRoutes } from "./routes"

const temporary: string[] = []
const codexHomeBefore = process.env.CODEX_HOME
afterEach(async () => {
  if (codexHomeBefore === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = codexHomeBefore
  await Promise.all(temporary.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("MachineInstalledDiscoveryRoutes", () => {
  test("GET / returns the { harnesses, skills } shape for claude, cursor and codex, machine-wide (never throws)", async () => {
    const app = new Hono()
    app.route("/machine-installed", MachineInstalledDiscoveryRoutes())

    const response = await app.request("http://local.test/machine-installed")
    expect(response.status).toBe(200)
    const body = await response.json() as unknown
    expect(body).toMatchObject({
      harnesses: [
        { harnessId: "claude", entries: expect.any(Array) },
        { harnessId: "cursor", entries: expect.any(Array) },
        { harnessId: "codex", entries: expect.any(Array) },
      ],
      skills: expect.any(Array),
    })
  })

  test("a SKILL.md folder under CODEX_HOME is served as a skill row", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-discovery-routes-"))
    temporary.push(codexHome)
    const root = path.join(codexHome, "skills", "docx")
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, "SKILL.md"), "---\nname: docx\ndescription: Write documents\n---\n")
    process.env.CODEX_HOME = codexHome

    const app = new Hono()
    app.route("/machine-installed", MachineInstalledDiscoveryRoutes())

    const body = await (await app.request("http://local.test/machine-installed")).json() as { skills: unknown[] }
    expect(body.skills).toContainEqual({ name: "docx", harnessId: "codex", root })
  })
})

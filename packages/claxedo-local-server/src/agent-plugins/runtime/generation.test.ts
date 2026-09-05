import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import {
  AgentPluginGenerationError,
  activateGeneration,
  cleanupInactiveGenerations,
  generationDirectory,
  readActiveGeneration,
} from "./generation"

const roots: string[] = []
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-plugin-generations-"))
  roots.push(root)
  return root
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))))

describe("Agent Plugins generations", () => {
  test("atomically points at a complete generation", async () => {
    const root = await fixture()
    const generationId = "generation-1-00000000-0000-4000-8000-000000000001"
    await fs.mkdir(generationDirectory(root, generationId), { recursive: true })

    await activateGeneration(root, { generationId, revision: 1 })

    expect(await readActiveGeneration(root)).toEqual({ generationId, revision: 1 })
  })

  test("rejects traversal in generation IDs and active pointers", async () => {
    const root = await fixture()
    expect(() => generationDirectory(root, "../../outside")).toThrowError(AgentPluginGenerationError)
    await fs.mkdir(path.join(root, "agent-plugins"), { recursive: true })
    await fs.writeFile(path.join(root, "agent-plugins", "active.json"), JSON.stringify({ generationId: "../../outside", revision: 1 }))
    await expect(readActiveGeneration(root)).rejects.toMatchObject({ code: "invalid-generation" })
  })

  test("rejects a pointer whose revision disagrees with its generation ID", async () => {
    const root = await fixture()
    const generationId = "generation-2-00000000-0000-4000-8000-000000000002"
    await fs.mkdir(generationDirectory(root, generationId), { recursive: true })
    await fs.mkdir(path.join(root, "agent-plugins"), { recursive: true })
    await fs.writeFile(path.join(root, "agent-plugins", "active.json"), JSON.stringify({ generationId, revision: 1 }))

    await expect(readActiveGeneration(root)).rejects.toMatchObject({ code: "invalid-generation" })
    await expect(activateGeneration(root, { generationId, revision: 1 })).rejects.toMatchObject({ code: "invalid-generation" })
  })

  test("cleans only inactive module-owned generation directories", async () => {
    const root = await fixture()
    const active = "generation-3-00000000-0000-4000-8000-000000000003"
    for (const generation of [
      "generation-1-00000000-0000-4000-8000-000000000001",
      "generation-2-00000000-0000-4000-8000-000000000002",
      active,
    ]) await fs.mkdir(generationDirectory(root, generation), { recursive: true })
    await fs.mkdir(path.join(root, "agent-plugins", "generations", "user-owned"), { recursive: true })
    await activateGeneration(root, { generationId: active, revision: 3 })

    await cleanupInactiveGenerations(root, 0)

    expect(await fs.readdir(path.join(root, "agent-plugins", "generations"))).toEqual([active, "user-owned"])
  })

  test("retains the newest inactive numeric revision", async () => {
    const root = await fixture()
    const active = "generation-11-00000000-0000-4000-8000-000000000011"
    const older = "generation-2-00000000-0000-4000-8000-000000000002"
    const newer = "generation-10-00000000-0000-4000-8000-000000000010"
    for (const generation of [older, newer, active]) {
      await fs.mkdir(generationDirectory(root, generation), { recursive: true })
    }
    await activateGeneration(root, { generationId: active, revision: 11 })

    await cleanupInactiveGenerations(root, 1)

    expect((await fs.readdir(path.join(root, "agent-plugins", "generations"))).toSorted()).toEqual([active, newer].toSorted())
  })
})

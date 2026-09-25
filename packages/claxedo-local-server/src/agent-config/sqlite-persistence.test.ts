import { afterAll, beforeEach, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"

const root = path.join(os.tmpdir(), `local-agent-settings-${randomUUID()}`)
const previous = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { ClaxedoDB } = await import("@claxedo/server-core/platform/db/index")
const { loadUserConfig, saveUserConfig } = await import("@claxedo/server-core/agent-config/index")
const { createAgentConfigRoutes } = await import("./routes/index")

beforeEach(async () => {
  ClaxedoDB.close()
  await fs.rm(root, { recursive: true, force: true })
})

afterAll(async () => {
  ClaxedoDB.close()
  await fs.rm(root, { recursive: true, force: true })
  if (previous === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previous
})

describe("local agent settings repository", () => {
  test("the route reads the persisted SQLite row after the database reopens", async () => {
    await saveUserConfig({ version: 3, connections: {}, mcp: { docs: { type: "remote", url: "https://docs.test/mcp" } } })
    ClaxedoDB.close()
    const response = await createAgentConfigRoutes().request("/mcp")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ docs: { type: "remote", url: "https://docs.test/mcp" } })
  })

  test("an old file cannot override the SQLite row", async () => {
    await saveUserConfig({ version: 3, connections: {}, mcp: {} })
    await fs.writeFile(path.join(root, "user-agent-config.json"), JSON.stringify({ version: 3, connections: {}, mcp: {
      old: { type: "remote", url: "https://old.test/mcp" },
    } }))
    expect((await loadUserConfig()).mcp).toEqual({})
  })
})

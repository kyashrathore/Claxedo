import { afterAll, beforeEach, expect, test, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { HarnessConnectionDescriptor } from "@claxedo/agent-sdk-runtime"
import type { AcpProviderConfig } from "@claxedo/harness/providers"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "connection-delete-"))
const previous = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root
vi.mock("../fanout", () => ({ fanOutConfig: vi.fn() }))
const { fanOutConfig } = await import("../fanout")
const { agentConfigConnectionRoutes } = await import("./connection-routes")
const { loadUserConfig, saveUserConfig } = await import("@claxedo/server-core/agent-config/index")
const published: string[][] = []

beforeEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
  published.length = 0
  vi.mocked(fanOutConfig).mockReset().mockImplementation(async () => {
    published.push(Object.keys((await loadUserConfig()).connections))
  })
})
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
  if (previous === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previous
})

const connection: HarnessConnectionDescriptor<AcpProviderConfig> = {
  connectionId: "conn-primary",
  providerKey: "acp",
  configRevision: 1,
  enabled: true,
  config: {
    label: "Agent conn-primary",
    connection: { kind: "streamable-http", url: "https://agent.example.test" },
    modelSelection: { status: "optional" },
  },
}
const remove = () => agentConfigConnectionRoutes().request("/connections/conn-primary", { method: "DELETE" })

test("deleting a connection twice succeeds both times and publishes the absence both times", async () => {
  await saveUserConfig({ version: 3, connections: { "conn-primary": connection } })
  expect((await remove()).status).toBe(200)
  expect((await remove()).status).toBe(200)
  expect(published).toEqual([[], []])
})

test("retrying a deletion after a refused push republishes the authoritative absence", async () => {
  await saveUserConfig({ version: 3, connections: { "conn-primary": connection } })
  vi.mocked(fanOutConfig).mockRejectedValueOnce(new Error("push refused"))
  expect((await remove()).status).toBe(500)
  expect(Object.keys((await loadUserConfig()).connections)).toEqual([])
  expect((await remove()).status).toBe(200)
  expect(published).toEqual([[]])
})

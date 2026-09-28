import { afterAll, beforeEach, expect, test, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "command-fanout-"))
const previous = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root
vi.mock("../fanout", () => ({ fanOutConfig: vi.fn() }))
const { fanOutConfig } = await import("../fanout")
const { agentConfigCommandRoutes } = await import("./command-routes")
const { listCommands, saveCommand } = await import("@claxedo/server-core/agent-config/index")
const published: Awaited<ReturnType<typeof listCommands>>[] = []

beforeEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
  published.length = 0
  vi.mocked(fanOutConfig).mockReset().mockImplementation(async () => { published.push(await listCommands()) })
})
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
  if (previous === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previous
})

function save(body: unknown = { name: "triage", content: "Triage $ARGUMENTS" }) {
  return agentConfigCommandRoutes().request("http://localhost/commands", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })
}

test("save publishes the persisted command before acknowledging", async () => {
  expect((await save()).status).toBe(201)
  expect(published).toEqual([[{ name: "triage", content: "Triage $ARGUMENTS" }]])
})

test("delete publishes removal before acknowledging", async () => {
  await saveCommand("triage", "Triage")
  const response = await agentConfigCommandRoutes().request("http://localhost/commands/triage", { method: "DELETE" })
  expect(response.status).toBe(200)
  expect(published).toEqual([[]])
})

test("invalid saves do not fan out", async () => {
  expect((await save({ name: "missing-content" })).status).toBe(400)
  expect(fanOutConfig).not.toHaveBeenCalled()
})

test("a failed push is reported and leaves the saved command available to retry", async () => {
  vi.mocked(fanOutConfig).mockRejectedValueOnce(new Error("push refused"))
  expect((await save()).status).toBe(500)
  expect(await listCommands()).toEqual([{ name: "triage", content: "Triage $ARGUMENTS" }])
  expect((await save()).status).toBe(201)
  expect(published).toEqual([[{ name: "triage", content: "Triage $ARGUMENTS" }]])
})

test("retrying a deletion after a refused push republishes the authoritative absence", async () => {
  await saveCommand("triage", "Triage")
  vi.mocked(fanOutConfig).mockRejectedValueOnce(new Error("push refused"))
  const remove = () => agentConfigCommandRoutes().request("http://localhost/commands/triage", { method: "DELETE" })
  expect((await remove()).status).toBe(500)
  expect(await listCommands()).toEqual([])
  expect((await remove()).status).toBe(200)
  expect(published).toEqual([[]])
})

test("the saved-command list names its origin, as the runtime command read does", async () => {
  await saveCommand("triage", "Triage")
  const response = await agentConfigCommandRoutes().request("http://localhost/commands")
  expect(await response.json()).toEqual([{ name: "triage", content: "Triage", origin: "saved" }])
})

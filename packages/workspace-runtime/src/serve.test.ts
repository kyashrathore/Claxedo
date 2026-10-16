import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { takeEventLoopActivity } from "@claxedo/helpers/event-loop-activity"
import { loopbackWorkspaceRuntimeExposure } from "./exposure"
import { startServer, waitForWorkspaceRuntimeServerPort } from "./serve"
import { loopbackMachineLoginPolicy } from "./testing"

const servers: Array<{ close(): unknown }> = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

async function listen(storeRoot: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "serve-workspace-"))
  takeEventLoopActivity()
  const server = await startServer(0, {
    sessionIdWorkspace: () => undefined,
    placement: loopbackMachineLoginPolicy(),
    exposure: loopbackWorkspaceRuntimeExposure(),
    storeRoot,
    target: { workspaceId: "ws_serve", directory },
  })
  servers.push(server)
  return { activity: takeEventLoopActivity(), port: await waitForWorkspaceRuntimeServerPort(server, 0) }
}

test("a workspace that has run OpenCode boots its engine before the runtime answers health", async () => {
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "serve-store-"))
  const database = path.join(storeRoot, "opencode", "opencode.db")
  fs.mkdirSync(path.dirname(database), { recursive: true })
  fs.writeFileSync(database, "")

  const { activity, port } = await listen(storeRoot)

  expect(activity).toEqual(["opencode engine boot", "opencode location activation"])
  expect(fs.statSync(database).size).toBeGreaterThan(0)
  expect((await fetch(`http://127.0.0.1:${port}/global/health`)).status).toBe(200)
}, 60_000)

test("a workspace that never ran OpenCode listens without booting it", async () => {
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "serve-store-"))

  const { activity, port } = await listen(storeRoot)

  expect(activity).toEqual([])
  expect(fs.existsSync(path.join(storeRoot, "opencode"))).toBe(false)
  expect((await fetch(`http://127.0.0.1:${port}/global/health`)).status).toBe(200)
})

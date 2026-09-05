import { afterAll, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-native-cutover-"))
const keys = [
  "CLAXEDO_DATA_DIR",
  "CLAXEDO_STATE_DIR",
  "CLAXEDO_DEPLOYMENT_MODE",
  "CLAXEDO_SIGNED_CLOUD_AUTH",
  "CLAXEDO_EMBEDDED_AUTH",
  "CLAXEDO_WORKSPACE_AUTHORITY_URL",
  "CLAXEDO_WAKES",
] as const
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
for (const key of keys) delete process.env[key]
process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")
await fs.mkdir(process.env.CLAXEDO_DATA_DIR, { recursive: true })
const { createSelfHostedApp, createDefaultLocalControlPlaneServices } =
  await import("../../deployments/self-hosted-node/app")
const services = createDefaultLocalControlPlaneServices()
const built = createSelfHostedApp(services)

afterAll(async () => {
  await built.dispose()
  services.close?.()
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
  await fs.rm(root, { recursive: true, force: true })
})
describe("native machine clean-break composition", () => {
  test.each([
    { harness: "pi", mode: "hybrid" },
    { harness: "pi", host: "central", workspaceId: "ws" },
    { harness: "pi" },
  ])("does not admit an obsolete or unbound execution request: %j", async (body) => {
    const response = await built.app.request("http://127.0.0.1/api/control/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "http://127.0.0.1" },
      body: JSON.stringify(body),
    })
    expect(response.status).toBe(400)
    expect(await services.projectionStore.list_session_metas({ includeArchived: false })).toEqual([])
  })
  test("no retired central prompt route can execute a turn", async () => {
    const response = await built.app.request("http://127.0.0.1/api/control/session/old-central/prompt_async", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "http://127.0.0.1" },
      body: JSON.stringify({ parts: [{ type: "text", text: "must not execute" }] }),
    })
    expect(response.status).toBe(404)
  })
})

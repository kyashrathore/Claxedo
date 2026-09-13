import { afterAll, afterEach, expect, test } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(os.tmpdir(), `agent-config-snapshot-${randomUUID().slice(0, 8)}`)
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const [{ createAgentConfigRoutes }, { configureAgentConfig, disposeAgentConfig }] = await Promise.all([
  import("./index"),
  import("@claxedo/server-core/agent-config/index"),
])

afterEach(async () => {
  disposeAgentConfig()
  await fs.rm(root, { recursive: true, force: true })
})

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
})

/**
 * The runtime snapshot carries broker placeholders — bearer authority over the
 * operator's stored credentials for the next hour. The runtime receives them
 * over its own management channel; this route is the config surface a page
 * reads, and it has no reason to hand them to anything that can call it.
 */
test("the agent-config snapshot route never carries the auth map", async () => {
  configureAgentConfig({
    projectAuth: async () => ({
      "claude-sdk": {
        baseUrl: "http://127.0.0.1:2595/bindings/b1",
        placeholder: "placeholder-that-must-not-travel",
        authMode: "bearer" as const,
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    }),
  })

  const response = await createAgentConfigRoutes().request("http://localhost/")
  const body = await response.text()

  expect(response.status).toBe(200)
  expect(JSON.parse(body)).not.toHaveProperty("auth")
  expect(body).not.toContain("placeholder-that-must-not-travel")
})

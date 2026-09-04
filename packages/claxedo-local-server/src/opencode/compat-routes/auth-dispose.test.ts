/**
 * Regression: disconnect must reach the embedded engine for auth removal AND
 * dispose so the provider catalog cannot stay "connected" after DELETE /auth.
 */
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest"
import { mkdirSync, realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import * as registry from "@claxedo/server-core/credentials/registry"
import * as fanout from "../../agent-config/fanout"

const root = path.join(realpathSync(os.tmpdir()), `compat-auth-dispose-${randomUUID().slice(0, 8)}`)
const prev = {
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
}
mkdirSync(root, { recursive: true })
process.env.CLAXEDO_DATA_DIR = root
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")

const { Hono } = await import("hono")
const { OpenCodeCompatRoutes } = await import("./index")

afterAll(async () => {
  process.env.CLAXEDO_DATA_DIR = prev.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_STATE_DIR = prev.CLAXEDO_STATE_DIR
  await fs.rm(root, { recursive: true, force: true })
})

function mountApp() {
  const app = new Hono()
  app.route("/", OpenCodeCompatRoutes())
  return app
}

describe("OpenCode credential ownership", () => {
  beforeEach(() => { vi.restoreAllMocks() })

  test("DELETE /auth uses the credential owner and fans out the new snapshot", async () => {
    const remove = vi.spyOn(registry, "deleteCredentialsByProvider").mockResolvedValue(undefined as never)
    const sync = vi.spyOn(fanout, "fanOutConfig").mockResolvedValue()
    const response = await mountApp().request("http://localhost/auth/openai?harness=opencode", { method: "DELETE" })
    expect(response.status).toBe(200)
    expect(await response.json()).toBe(true)
    expect(remove).toHaveBeenCalledWith("openai")
    expect(sync).toHaveBeenCalledOnce()
  })

  test("the removed engine-disposal endpoint cannot be invoked", async () => {
    expect((await mountApp().request("http://localhost/global/dispose", { method: "POST" })).status).toBe(404)
  })
})

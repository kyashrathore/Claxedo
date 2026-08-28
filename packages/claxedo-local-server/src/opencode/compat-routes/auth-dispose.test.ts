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
import * as engine from "@claxedo/server-core/opencode/engine"

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

describe("OpenCode compat auth/dispose routes", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  test("DELETE /auth/:id proxies to the engine then disposes cached instances", async () => {
    const opencodeRequest = vi.spyOn(engine, "opencodeRequest").mockImplementation(async (req: Request) => {
      const url = new URL(req.url)
      if (url.pathname === "/auth/openai" && req.method === "DELETE") {
        return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } })
      }
      if (url.pathname === "/global/dispose" && req.method === "POST") {
        return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } })
      }
      return new Response(`unexpected ${url.pathname}`, { status: 500 })
    })

    const app = mountApp()
    const res = await app.request("http://localhost/auth/openai?harness=opencode", { method: "DELETE" })
    expect(res.status).toBe(200)
    await expect(res.text()).resolves.toBe("true")

    expect(opencodeRequest).toHaveBeenCalledTimes(2)
    const paths = opencodeRequest.mock.calls.map((call) => new URL((call[0] as Request).url).pathname)
    expect(paths).toEqual(["/auth/openai", "/global/dispose"])
  })

  test("PATCH /global/config disposes cached instances after upstream patch", async () => {
    const opencodeRequest = vi.spyOn(engine, "opencodeRequest").mockImplementation(async (req: Request) => {
      const url = new URL(req.url)
      if (url.pathname === "/global/config" && req.method === "PATCH") {
        return new Response(JSON.stringify({ disabled_providers: ["clinepass-2"] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      if (url.pathname === "/global/dispose" && req.method === "POST") {
        return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } })
      }
      return new Response("unexpected", { status: 500 })
    })

    const app = mountApp()
    const res = await app.request("http://localhost/global/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { disabled_providers: ["clinepass-2"] } }),
    })
    expect(res.status).toBe(200)

    expect(opencodeRequest).toHaveBeenCalledTimes(2)
    const paths = opencodeRequest.mock.calls.map((call) => new URL((call[0] as Request).url).pathname)
    expect(paths).toEqual(["/global/config", "/global/dispose"])
  })

  test("POST /global/dispose proxies to the engine instead of returning a local stub", async () => {
    const opencodeRequest = vi.spyOn(engine, "opencodeRequest").mockImplementation(async (req: Request) => {
      const url = new URL(req.url)
      if (url.pathname === "/global/dispose" && req.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response("unexpected", { status: 500 })
    })

    const app = mountApp()
    const res = await app.request("http://localhost/global/dispose", { method: "POST" })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
    expect(opencodeRequest).toHaveBeenCalledTimes(1)
    expect(new URL((opencodeRequest.mock.calls[0]![0] as Request).url).pathname).toBe("/global/dispose")
  })
})

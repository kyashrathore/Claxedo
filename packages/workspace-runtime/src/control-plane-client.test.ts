import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { createControlPlaneClient } from "./control-plane-client"

const env = {
  ...process.env,
}

beforeEach(() => {
  process.env.CLAXEDO_CONTROL_PLANE_URL = "http://control.test"
  process.env.CLAXEDO_WR_WORKSPACE_ID = "ws_123"
})

afterEach(() => {
  process.env.CLAXEDO_CONTROL_PLANE_URL = env.CLAXEDO_CONTROL_PLANE_URL
  process.env.CLAXEDO_WR_WORKSPACE_ID = env.CLAXEDO_WR_WORKSPACE_ID
  mock.restore()
})

describe("control plane client", () => {
  it("builds typed workspace-scoped tRPC requests", async () => {
    const seen: Array<{ url: string; method: string; body: string | undefined }> = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      seen.push({
        url: typeof input === "string" ? input : input.url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      })
      return new Response(JSON.stringify([{ result: { data: { json: { ok: true } } } }]), { status: 200 })
    }) as typeof fetch

    try {
      const client = createControlPlaneClient()
      expect(client).toBeDefined()
      await client!.session.sync({ id: "session-1" })
    } finally {
      globalThis.fetch = original
    }

    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toContain("http://control.test/api/control/trpc/session.sync")
    expect(seen[0]?.method).toBe("POST")
    expect(seen[0]?.body).toContain("ws_123")
    expect(seen[0]?.body).toContain("session-1")
  })

  it("routes runtime sync and session hooks through the shared client", () => {
    const clientFile = path.resolve(import.meta.dir, "./control-plane-client.ts")
    const sessionFile = path.resolve(import.meta.dir, "./routes/session.ts")
    const serverFile = path.resolve(import.meta.dir, "./server.ts")
    const clientText = fs.readFileSync(clientFile, "utf8")
    const sessionText = fs.readFileSync(sessionFile, "utf8")
    const serverText = fs.readFileSync(serverFile, "utf8")

    expect(clientText).toContain('url: `${base}/api/control/trpc`')
    expect(clientText).toContain("client.session.sync.mutate")
    expect(clientText).toContain("client.runtime.register.mutate")
    expect(clientText).toContain("client.runtime.heartbeat.mutate")
    expect(sessionText).toContain("const controlPlane = createControlPlaneClient()")
    expect(sessionText).toContain("await controlPlane?.session.sync(session)")
    expect(serverText).toContain('import { startControlPlaneRuntimeSync } from "./control-plane-client"')
    expect(serverText).toContain("const stopControlPlaneSync = startControlPlaneRuntimeSync(host)")
  })
})

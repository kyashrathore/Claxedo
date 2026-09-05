import { afterAll, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "shell-events-route-"))
const previous = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root
const [{ ShellRoutes }, { claxedoBus }, { ClaxedoDB }] = await Promise.all([
  import("./routes"),
  import("@claxedo/server-core/platform/runtime/lib/bus"),
  import("@claxedo/server-core/platform/db/index"),
])

afterAll(async () => {
  ClaxedoDB.close()
  if (previous === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previous
  await fs.rm(root, { recursive: true, force: true })
})

describe("shell control-plane events entrypoint", () => {
  test("serves actual central lifecycle events on the frontend's endpoint", async () => {
    const app = ShellRoutes({ authConfig: { enabled: false, mode: "local-only", reason: "test loopback deployment" } })
    const abort = new AbortController()
    const response = await app.request("http://127.0.0.1/api/claxedo/events", { signal: abort.signal })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const reader = response.body!.getReader()
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("server.connected")
      claxedoBus.publish({ type: "session.lifecycle", phase: "created", sessionID: "ses_route", directory: "/workspace", info: { id: "ses_route" }, ts: 1 })
      const frame = new TextDecoder().decode((await reader.read()).value)
      expect(frame).toContain('"type":"session.lifecycle"')
      expect(frame).toContain('"sessionID":"ses_route"')
    } finally {
      abort.abort()
      await reader.cancel()
    }
  })

  test("requires a verified identity and filters recipient-scoped events", async () => {
    const app = ShellRoutes({
      authConfig: { enabled: true, issuer: "https://auth.test", jwksUrl: "custom:test" },
      verifier: async () => ({ mode: "signed", user: { subject: "user_a", orgId: "org_a", issuer: "https://auth.test", tokenIdentifier: "user_a" } }),
    })
    expect((await app.request("/api/claxedo/events")).status).toBe(401)
    const abort = new AbortController()
    const response = await app.request("/api/claxedo/events", { headers: { authorization: "Bearer signed" }, signal: abort.signal })
    const reader = response.body!.getReader()
    try {
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/event-stream")
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("server.connected")
      claxedoBus.publish({ type: "session.share.changed", phase: "granted", ownerUserId: "user_b", sessionId: "private_b", workspaceId: "ws_b", ts: 1 })
      // An issuer org claim cannot substitute for an authority-resolved org ID.
      claxedoBus.publish({ type: "document.changed", orgId: "org_a", projectId: "project_a", documentId: "unresolved_org", ts: 2 })
      claxedoBus.publish({ type: "session.share.changed", phase: "granted", ownerUserId: "user_a", sessionId: "visible_a", workspaceId: "ws_a", ts: 3 })
      const frame = new TextDecoder().decode((await reader.read()).value)
      expect(frame).toContain("visible_a")
      expect(frame).not.toContain("private_b")
      expect(frame).not.toContain("unresolved_org")
    } finally {
      abort.abort()
      await reader.cancel()
    }
  })
})

import { afterEach, describe, expect, it, vi } from "vitest"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { sandboxFetch } from "@claxedo/server-core/workspace/http/sandbox-target-fetch"
import { sandboxJson } from "./sandbox-json"

vi.mock("@claxedo/server-core/workspace/http/sandbox-target-fetch", () => ({ sandboxFetch: vi.fn() }))
afterEach(() => vi.resetAllMocks())

const workspace: Workspace = { id: "ws-1", directory: "/project", kind: "local", created_at: 1, updated_at: 1 }

describe("sandboxJson", () => {
  it("forwards the exact request and returns the runtime response", async () => {
    vi.mocked(sandboxFetch).mockResolvedValueOnce(Response.json({ ready: true }))
    expect(await sandboxJson(workspace, "/api/wr/health?sessionId=old-session")).toEqual({ ready: true })
    expect(sandboxFetch).toHaveBeenCalledWith(workspace, "/api/wr/health?sessionId=old-session", undefined, {})
  })

  it("preserves the authoritative runtime failure instead of returning catalog data", async () => {
    vi.mocked(sandboxFetch).mockResolvedValueOnce(Response.json({ error: { message: "Connection disabled" } }, { status: 409 }))
    await expect(sandboxJson(workspace, "/api/wr/health")).rejects.toThrow("Connection disabled")
  })

  it("reports non-JSON transport failures", async () => {
    vi.mocked(sandboxFetch).mockResolvedValueOnce(new Response("Unavailable", { status: 503 }))
    await expect(sandboxJson(workspace, "/api/wr/health")).rejects.toThrow("sandbox request failed: 503")
  })
})

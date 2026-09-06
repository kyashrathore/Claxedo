import { describe, expect, test, vi } from "vitest"
import { z } from "zod"
import { registerCloudWorkspaceTools } from "./cloud-workspace-tools"
import type { McpToolResult } from "./mcp-tool"

/** A fetch body this suite always sends as JSON text; anything else is a bug in the test. */
function jsonBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") throw new Error(`expected a JSON string request body, got ${typeof body}`)
  return JSON.parse(body)
}

function tools(readOnly = false) {
  // The handler signature is the registration port's, so a change to what a
  // tool receives or answers with fails here rather than being absorbed.
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<McpToolResult>>()
  // Arguments go through the tool's own declared schema, the way the server
  // does it — so a call in this suite that a real client could not make fails
  // here instead of exercising a handler on input it would never receive.
  // Typed as the real seam so `mock.calls` carries the (path, init) tuple and
  // `mockResolvedValueOnce` accepts any response shape the routes can return.
  const request = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(async () => ({ ok: true }))
  registerCloudWorkspaceTools(
    (name, config, handler) => {
      const schema = z.object(config.inputSchema)
      handlers.set(name, (args) => handler(schema.parse(args), { requestId: 1 }))
    },
    request,
    readOnly,
  )
  return { handlers, request }
}

describe("cloud workspace MCP tools", () => {
  test("read-only mode exposes status without mutation tools", () => {
    expect([...tools(true).handlers.keys()]).toEqual(["cloud_workspace_status"])
  })

  test("status, checkpoint, and stop use the shared application routes", async () => {
    const fixture = tools()
    await fixture.handlers.get("cloud_workspace_status")!({ workspace_id: "ws_1" })
    await fixture.handlers.get("cloud_workspace_checkpoint")!({ workspace_id: "ws_1", policy: "interrupt" })
    await fixture.handlers.get("cloud_workspace_lifecycle")!({ workspace_id: "ws_1", action: "stop" })

    expect(fixture.request.mock.calls.map(([path]) => path)).toEqual([
      "/api/workspace/ws_1/checkpoints",
      "/api/workspace/ws_1/checkpoints",
      "/api/workspace/ws_1/lifecycle/stop",
    ])
    expect(jsonBody(fixture.request.mock.calls[1][1]?.body)).toEqual({ policy: "interrupt" })
  })

  test("restore and destructive actions fail locally until explicitly approved", async () => {
    const fixture = tools()
    const lifecycle = fixture.handlers.get("cloud_workspace_lifecycle")!

    await expect(lifecycle({
      workspace_id: "ws_1",
      action: "restore",
      checkpoint_id: "cp_1",
    })).rejects.toThrow(/Explicit approval/)
    expect(fixture.request).not.toHaveBeenCalled()

    await lifecycle({
      workspace_id: "ws_1",
      action: "restore",
      checkpoint_id: "cp_1",
      approved: true,
    })
    expect(fixture.request).toHaveBeenCalledWith(
      "/api/workspace/ws_1/checkpoints/cp_1/restore",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ approved: true }) }),
    )
  })

  test("restore resolves the latest checkpoint when no checkpoint id is supplied", async () => {
    const fixture = tools()
    fixture.request.mockResolvedValueOnce({ checkpoint: { id: "cp_latest" } })

    await fixture.handlers.get("cloud_workspace_lifecycle")!({
      workspace_id: "ws_1",
      action: "restore",
      approved: true,
    })

    expect(fixture.request.mock.calls.map(([path]) => path)).toEqual([
      "/api/workspace/ws_1/checkpoints",
      "/api/workspace/ws_1/checkpoints/cp_latest/restore",
    ])
  })
})

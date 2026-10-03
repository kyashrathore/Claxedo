import { expect, test, vi } from "vitest"
import { requestIdleStop, workspaceIdlePlacement } from "./workspace-idle"

const idle = { workspaceId: "ws_1", epoch: 7, port: 2593, idleMs: 600_000, healthToken: "health" }
const env = { API_TOKEN: "worker-token", CONTROL_PLANE_URL: "https://control.test/" }

test("a runtime idle for the whole window asks the control plane, with the Worker's token, to stop this lease generation", async () => {
  const send = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ ok: true, status: "stopped" }))
  const health = Response.json({ workspaceId: "ws_1", idleSince: 1_000 })
  expect(await requestIdleStop(idle, health, env, 601_000, send)).toBe(true)
  expect(send).toHaveBeenCalledWith("https://control.test/internal/sandbox/idle-stop", expect.objectContaining({
    headers: expect.objectContaining({ authorization: "Bearer worker-token" }),
    body: JSON.stringify({ workspaceId: "ws_1", epoch: 7, idleBefore: 1_000 }),
  }))
})

test("work inside the window, work in progress, or another workspace's answer never asks for a stop", async () => {
  const send = vi.fn(async () => Response.json({ ok: true }))
  expect(await requestIdleStop(idle, Response.json({ workspaceId: "ws_1", idleSince: 1_001 }), env, 601_000, send)).toBe(false)
  expect(await requestIdleStop(idle, Response.json({ workspaceId: "ws_1" }), env, 601_000, send)).toBe(false)
  await expect(requestIdleStop(idle, Response.json({ workspaceId: "ws_2", idleSince: 0 }), env, 601_000, send)).rejects.toThrow("another workspace")
  await expect(requestIdleStop(idle, new Response("", { status: 401 }), env, 601_000, send)).rejects.toThrow("401")
  expect(send).not.toHaveBeenCalled()
})

test("a refused stop is an error the next check retries", async () => {
  const send = vi.fn(async () => new Response("runtime_lease_changed", { status: 409 }))
  await expect(requestIdleStop(idle, Response.json({ workspaceId: "ws_1", idleSince: 0 }), env, 601_000, send)).rejects.toThrow("409")
})

test("the idle lifecycle needs the lease's labels and the control plane's origin", () => {
  expect(workspaceIdlePlacement({ workspaceId: "ws_1", epoch: "7" }, 2593, env)).toEqual({ workspaceId: "ws_1", epoch: 7, port: 2593, idleMs: 600_000 })
  expect(workspaceIdlePlacement({ workspaceId: "ws_1", epoch: "7" }, 2593, { API_TOKEN: "t" })).toBeUndefined()
  expect(workspaceIdlePlacement({ workspaceId: "ws_1", epoch: "zero" }, 2593, env)).toBeUndefined()
  expect(workspaceIdlePlacement({ epoch: "7" }, 2593, env)).toBeUndefined()
  expect(workspaceIdlePlacement({ workspaceId: "ws_1", epoch: "7" }, 2593, { ...env, WORKSPACE_IDLE_MS: "1000" })).toBeUndefined()
})

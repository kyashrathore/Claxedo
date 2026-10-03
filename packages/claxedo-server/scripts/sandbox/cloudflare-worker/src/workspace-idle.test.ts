import { expect, test, vi } from "vitest"
import { requestIdleStop, workspaceIdlePlacement } from "./workspace-idle"

const idle = { workspaceId: "ws_1", epoch: 7, port: 2593, idleMs: 600_000, healthToken: "health" }
const env = { IDLE_STOP_TOKEN: "idle-token", CONTROL_PLANE_URL: "https://control.test/" }
const stopped = () => Response.json({ ok: true, status: "stopped", checkpoint: "a,b" })

test("a runtime idle for the whole window asks the control plane, with the idle-stop token, to stop this lease generation", async () => {
  const send = vi.fn(async (_url: string, _init: RequestInit) => stopped())
  const health = Response.json({ workspaceId: "ws_1", idleSince: 1_000 })
  expect(await requestIdleStop(idle, health, env, 601_000, send)).toEqual({ checkpoint: "a,b" })
  expect(send).toHaveBeenCalledWith("https://control.test/internal/sandbox/idle-stop", expect.objectContaining({
    headers: expect.objectContaining({ authorization: "Bearer idle-token" }),
    body: JSON.stringify({ workspaceId: "ws_1", epoch: 7, idleBefore: 1_000 }),
  }))
})

test("a runtime frozen past any checkpoint's deadline is handed to the control plane too, and a fresh freeze is not", async () => {
  const send = vi.fn(async (_url: string, _init: RequestInit) => stopped())
  expect(await requestIdleStop(idle, Response.json({ workspaceId: "ws_1", frozenSince: 601_000 - 15 * 60_000 }), env, 601_000, send)).toEqual({ checkpoint: "a,b" })
  expect(await requestIdleStop(idle, Response.json({ workspaceId: "ws_1", frozenSince: 600_000 }), env, 601_000, send)).toBeUndefined()
  expect(send).toHaveBeenCalledOnce()
})

test("work inside the window, work in progress, or another workspace's answer never asks for a stop", async () => {
  const send = vi.fn(async (_url: string, _init: RequestInit) => stopped())
  expect(await requestIdleStop(idle, Response.json({ workspaceId: "ws_1", idleSince: 1_001 }), env, 601_000, send)).toBeUndefined()
  expect(await requestIdleStop(idle, Response.json({ workspaceId: "ws_1" }), env, 601_000, send)).toBeUndefined()
  await expect(requestIdleStop(idle, Response.json({ workspaceId: "ws_2", idleSince: 0 }), env, 601_000, send)).rejects.toThrow("another workspace")
  await expect(requestIdleStop(idle, new Response("", { status: 401 }), env, 601_000, send)).rejects.toThrow("401")
  expect(send).not.toHaveBeenCalled()
})

test("a refused stop is an error the next check counts", async () => {
  const send = vi.fn(async (_url: string, _init: RequestInit) => new Response("runtime_lease_changed", { status: 409 }))
  await expect(requestIdleStop(idle, Response.json({ workspaceId: "ws_1", idleSince: 0 }), env, 601_000, send)).rejects.toThrow("409")
})

test("the idle lifecycle needs the lease's labels, the control plane's origin and the idle-stop token", () => {
  expect(workspaceIdlePlacement({ workspaceId: "ws_1", epoch: "7" }, 2593, env)).toEqual({ workspaceId: "ws_1", epoch: 7, port: 2593, idleMs: 600_000 })
  expect(workspaceIdlePlacement({ workspaceId: "ws_1", epoch: "7" }, 2593, { IDLE_STOP_TOKEN: "t" })).toBeUndefined()
  expect(workspaceIdlePlacement({ workspaceId: "ws_1", epoch: "7" }, 2593, { CONTROL_PLANE_URL: "https://control.test" })).toBeUndefined()
  expect(workspaceIdlePlacement({ workspaceId: "ws_1", epoch: "zero" }, 2593, env)).toBeUndefined()
  expect(workspaceIdlePlacement({ epoch: "7" }, 2593, env)).toBeUndefined()
  expect(workspaceIdlePlacement({ workspaceId: "ws_1", epoch: "7" }, 2593, { ...env, WORKSPACE_IDLE_MS: "1000" })).toBeUndefined()
})

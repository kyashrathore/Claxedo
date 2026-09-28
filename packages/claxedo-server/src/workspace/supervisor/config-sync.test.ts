import { afterEach, expect, test, vi } from "vitest"
import type { WorkspaceRuntimeState } from "./store"

const snapshots = vi.hoisted(() => ({ next: 0 }))
vi.mock("@claxedo/server-core/hosts/workspace-runtime/runtime-config", () => ({
  createClaxedoRuntimeConfig: async () => ({ revision: ++snapshots.next }),
}))
vi.mock("./control-token", () => ({
  configTokenHeaders: () => ({}),
  stateConfigToken: () => "token",
  supervisorBackplaneHeaders: async () => ({}),
}))

const { pushRuntimeConfig } = await import("./config-sync")

afterEach(() => vi.unstubAllGlobals())

test("concurrent pushes land in the order their snapshots were read, so the runtime ends on the newest", async () => {
  const landed: number[] = []
  let calls = 0
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const first = calls++ === 0
    await new Promise((resolve) => setTimeout(resolve, first ? 50 : 0))
    landed.push((JSON.parse(init.body) as { revision: number }).revision)
    return new Response(null, { status: 204 })
  })
  const state = {
    ws: { id: "ws-order", kind: "local", directory: "/tmp/ws-order", created_at: 1, updated_at: 1 },
    url: "http://127.0.0.1:2599", status: "ready", used_at: 0, crashes: 0, retry_at: 0, active: 0, holds: [],
  } as unknown as WorkspaceRuntimeState

  await Promise.all([pushRuntimeConfig(state), pushRuntimeConfig(state)])

  expect(landed).toEqual([1, 2])
})

test("a workspace whose runtime state was replaced mid-push still lands its pushes in snapshot order", async () => {
  const landed: number[] = []
  let calls = 0
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const first = calls++ === 0
    await new Promise((resolve) => setTimeout(resolve, first ? 50 : 0))
    landed.push((JSON.parse(init.body) as { revision: number }).revision)
    return new Response(null, { status: 204 })
  })
  const runtime = (url: string) => ({
    ws: { id: "ws-replaced", kind: "local", directory: "/tmp/ws-replaced", created_at: 1, updated_at: 1 },
    url, status: "ready", used_at: 0, crashes: 0, retry_at: 0, active: 0, holds: [],
  }) as unknown as WorkspaceRuntimeState
  const before = snapshots.next

  await Promise.all([pushRuntimeConfig(runtime("http://127.0.0.1:2601")), pushRuntimeConfig(runtime("http://127.0.0.1:2602"))])

  expect(landed).toEqual([before + 1, before + 2])
})

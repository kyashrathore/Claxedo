import { afterEach, expect, test, vi } from "vitest"
import { SqliteWakeStore } from "@claxedo/wakes/sqlite"
import { createMachineWakes } from "./machine-wakes"
import type { ControlPlaneServices } from "../authority/services"
import type { MachineSessionDispatch } from "./machine-dispatch"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
function fixture(signed = false) {
  let now = 1_000_000
  const store = new SqliteWakeStore({ path: ":memory:" })
  let history: unknown[] = [{ info: { id: "user-turn", role: "user" } }]
  const runtime = {
    authorize: vi.fn(async () => ({ workspaceId: "workspace" })),
    request: vi.fn(async (_session, resource) =>
      resource === "message" ? Response.json(history) : new Response(null, { status: 204 }),
    ),
  }
  const controller = createMachineWakes({
    services: {
      auth: { config: { enabled: signed, mode: signed ? "signed" : "local-only" } },
    } as unknown as ControlPlaneServices,
    runtime: runtime as unknown as MachineSessionDispatch,
    store,
    now: () => now,
  })
  cleanups.push(async () => {
    await controller.stop()
    store.close()
  })
  const call = (session: string, name: string, input: object, toolCallId = "call-1", origin = "http://localhost") =>
    controller.routes.request(`${origin}/sessions/${session}/wakes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, input, toolCallId }),
    })
  return {
    store,
    runtime,
    controller,
    call,
    advance: () => {
      now += 2000
    },
    history: (value: unknown[]) => {
      history = value
    },
  }
}
test("schedules once through the public machine route and delivers once with a stable admission identity", async () => {
  const f = fixture()
  expect((await f.call("session", "schedule_followup", { when: "+1s", intent: "check file" })).status).toBe(200)
  expect((await f.call("session", "schedule_followup", { when: "+1s", intent: "check file" })).status).toBe(200)
  const pending = await f.controller.wakes.listForSession("session")
  expect(pending).toHaveLength(1)
  expect(pending[0]).toMatchObject({ workspaceId: "workspace", depth: 1 })
  f.advance()
  await f.controller.wakes.runDue()
  await f.controller.wakes.runDue()
  const sends = f.runtime.request.mock.calls.filter(([, resource]) => resource === "prompt_async")
  expect(sends).toHaveLength(1)
  expect(JSON.parse((sends[0] as unknown as [string, string, RequestInit])[2].body as string)).toMatchObject({
    messageID: `wake:${pending[0]!.id}`,
  })
})
test("enforces session ownership on cancellation and machine access before scheduling", async () => {
  const f = fixture()
  await f.call("session", "schedule_followup", { when: "+1s" })
  const [wake] = await f.controller.wakes.listForSession("session")
  expect(await (await f.call("other", "cancel_wake", { wake_id: wake!.id })).json()).toMatchObject({ ok: false })
  f.runtime.authorize.mockRejectedValueOnce(Object.assign(new Error("private session denied"), { status: 403 }))
  expect((await f.call("session", "schedule_followup", { when: "+1s" }, "new-call")).status).toBe(403)
  expect(await f.controller.wakes.listForSession("session")).toHaveLength(1)
})
test("uses the stored wake creator at delivery and refuses a revoked actor", async () => {
  const f = fixture(true)
  await f.controller.wakes.schedule({
    sessionId: "session",
    workspaceId: "workspace",
    createdBy: "actor",
    at: 1_001_000,
    intent: "continue",
  })
  f.runtime.authorize.mockRejectedValueOnce(new Error("actor revoked"))
  f.advance()
  await expect(f.controller.wakes.runDue()).rejects.toThrow("actor revoked")
  expect(f.runtime.authorize).toHaveBeenCalledWith("session", { kind: "actor", actorId: "actor" })
  expect(f.runtime.request).not.toHaveBeenCalled()
})
test("rejects remote unsigned callers and drains before refusing new wake requests", async () => {
  const f = fixture()
  expect((await f.call("session", "schedule_followup", { when: "+1s" }, "call", "https://remote.example")).status).toBe(
    401,
  )
  await f.controller.stop()
  expect((await f.call("session", "schedule_followup", { when: "+1s" })).status).toBe(503)
  expect(f.runtime.request).not.toHaveBeenCalled()
})

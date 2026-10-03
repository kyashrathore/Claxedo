import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { SessionDeleteRequest } from "@claxedo/agent-runtime-contract"
import { createHostFixture, sessionCreate, controlledTurn, until } from "../test-support/host-fixture"
import { FakeTransport } from "../test-support/fake-transport"
import { createTurnAdmissions } from "../host/turn-admission"
import { createSessionRoutes } from "./session-core"
import type { SessionRouteOptions } from "./session-route-options"

async function fixture(options: Partial<SessionRouteOptions> = {}) {
  const transport = new FakeTransport()
  const host = createHostFixture({ transports: { pi: transport } })
  await host.runtime.sessions.create(sessionCreate({ id: "root" }))
  const app = createSessionRoutes({
    runtime: async () => host.runtime, defaultHarness: () => ({ id: "pi", access: "native" }),
    requestedSessionHarness: () => undefined, resolveDirectory: () => "/repo",
    sessionIdWorkspace: () => "ws", publishGlobal: () => {}, ...options,
  })
  const selected = (): SessionDeleteRequest => {
    const facts = host.store.getSession("root")!.attention!
    return {
      expected: { generation: facts.generation, activitySequence: facts.activitySequence },
      descendants: host.store.sessionDescendants("root").map(sessionId => {
        const child = host.store.getSession(sessionId)!.attention!
        return { sessionId, generation: child.generation, activitySequence: child.activitySequence }
      }),
    }
  }
  const remove = (body: unknown) => app.request("/session/root", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const child = (id: string, parentID = "root") => host.runtime.sessions.create({ ...sessionCreate({ id }), parentID })
  return { ...host, app, transport, selected, remove, child }
}

void describe("guarded public session deletion", () => {
  void it("previews every descendant and applies each leaf's hooks before its parent", async () => {
    const effects: string[] = []
    const f = await fixture({ beforeDeleteSession: (_c, _directory, id) => { effects.push(`before:${id}`) },
      disposeSessionDocuments: async id => { effects.push(`documents:${id}`) },
      afterDeleteSession: (_c, _directory, id) => { effects.push(`after:${id}`) } })
    try {
      await f.child("z-child")
      await f.child("a-grandchild", "z-child")
      const response = await f.app.request("/session/root/children")
      assert.equal(response.status, 200)
      const descendants = await response.json() as Array<{ id: string; attention: unknown }>
      assert.deepEqual(new Set(descendants.map(row => row.id)), new Set(["z-child", "a-grandchild"]))
      assert.ok(descendants.every(row => row.attention))
      const deleted = await f.remove(f.selected())
      assert.equal(deleted.status, 200)
      assert.deepEqual(await deleted.json(), { ok: true, deletedSessionIds: ["a-grandchild", "z-child", "root"] })
      assert.deepEqual(effects, ["before:a-grandchild", "documents:a-grandchild", "after:a-grandchild", "before:z-child", "documents:z-child", "after:z-child", "before:root", "documents:root", "after:root"])
      assert.equal(f.store.getSession("root"), null)
      assert.equal(f.store.getSession("z-child"), null)
      assert.equal(f.store.getSession("a-grandchild"), null)
    } finally { await f.dispose() }
  })

  void it("refuses a changed descendant set before any deletion effect", async () => {
    const effects: string[] = []
    const f = await fixture({ beforeDeleteSession: (_c, _dir, id) => { effects.push(id) } })
    try {
      const selected = f.selected()
      await f.child("new-child")
      const response = await f.remove(selected)
      assert.equal(response.status, 409)
      assert.equal((await response.json()).error.details.reason, "children_changed")
      assert.deepEqual(effects, [])
      assert.deepEqual(f.transport.closed, [])
      assert.ok(f.store.getSession("new-child"))
    } finally { await f.dispose() }
  })

  void it("refuses a durable turn owned elsewhere before removing any cascading target", async () => {
    const effects: string[] = []
    const f = await fixture({ beforeDeleteSession: (_c, _dir, id) => { effects.push(id) } })
    let release: (() => void) | undefined
    try {
      await f.child("child")
      const competitor = createTurnAdmissions(f.store)
      const admitted = competitor.claim("child", { turnId: "other", assistantMessageId: "reply" })!
      release = admitted.release
      const response = await f.remove(f.selected())
      assert.equal(response.status, 409)
      assert.deepEqual((await response.json()).error.details, { sessionId: "child", reason: "working" })
      assert.deepEqual(effects, [])
      assert.deepEqual(f.transport.closed, [])
      assert.ok(f.store.getSession("root"))
    } finally { release?.(); await f.dispose() }
  })

  void it("holds turn admission and cross-host child creation throughout asynchronous hooks", async () => {
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const f = await fixture({ beforeDeleteSession: async () => { entered(); await held } })
    const competitor = createHostFixture({ store: f.store, transports: { pi: new FakeTransport() } })
    try {
      const deleting = f.remove(f.selected())
      await started
      assert.equal(createTurnAdmissions(f.store).claim("root", { turnId: "late", assistantMessageId: "reply" }), undefined)
      await assert.rejects(f.runtime.turns.start({ sessionId: "root", text: "late", origin: sessionCreate().origin }), { code: "session_turn_in_progress" })
      await assert.rejects(competitor.runtime.sessions.create({ ...sessionCreate({ id: "late-child" }), parentID: "root" }), { code: "session_turn_in_progress" })
      assert.equal(f.store.getSession("late-child"), null)
      release()
      assert.equal((await deleting).status, 200)
      assert.equal(f.store.readTurnAuthority("root"), undefined)
    } finally { release(); await competitor.dispose(); await f.dispose() }
  })

  void it("rejects an earlier activity selection after a completed turn", async () => {
    const control = controlledTurn("root")
    const transport = new FakeTransport({ turn: () => control.events })
    const host = createHostFixture({ transports: { pi: transport } })
    try {
      await host.runtime.sessions.create(sessionCreate({ id: "root" }))
      const facts = host.store.getSession("root")!.attention!
      const request = { expected: { generation: facts.generation, activitySequence: facts.activitySequence }, descendants: [] }
      const app = createSessionRoutes({ runtime: async () => host.runtime, defaultHarness: () => ({ id: "pi", access: "native" }),
        requestedSessionHarness: () => undefined, resolveDirectory: () => "/repo", sessionIdWorkspace: () => "ws", publishGlobal: () => {} })
      await host.runtime.turns.start({ sessionId: "root", text: "new work", origin: sessionCreate().origin })
      control.finish()
      await until(() => host.store.getSession("root")?.status === "idle")
      const response = await app.request("/session/root", { method: "DELETE", body: JSON.stringify(request), headers: { "content-type": "application/json" } })
      assert.equal(response.status, 409)
      assert.equal((await response.json()).error.details.reason, "activity_changed")
      assert.deepEqual(transport.closed, [])
      assert.ok(host.store.getSession("root"))
    } finally { control.finish(); await host.dispose() }
  })

  void it("never treats a malformed guarded body as a bare delete", async () => {
    const f = await fixture()
    try {
      for (const body of [{}, { expected: f.selected().expected }, { expected: { generation: -1, activitySequence: 1 }, descendants: [] }]) {
        assert.equal((await f.remove(body)).status, 400)
      }
      const malformed = await f.app.request("/session/root", { method: "DELETE", body: "{", headers: { "content-type": "application/json" } })
      assert.equal(malformed.status, 400)
      assert.deepEqual(f.transport.closed, [])
      assert.ok(f.store.getSession("root"))
    } finally { await f.dispose() }
  })

  void it("preserves bare deletion when a forwarding hop supplies a zero-byte stream", async () => {
    const f = await fixture()
    try {
      const body = new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
      const request = new Request("http://runtime.local/session/root", { method: "DELETE", body, duplex: "half" } as RequestInit)
      assert.ok(request.body)
      const response = await f.app.fetch(request)
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { ok: true })
      assert.equal(f.store.getSession("root"), null)
      assert.equal(f.transport.closed.length, 1)
    } finally { await f.dispose() }
  })

  void it("reports exact child removal after a later hook fails and releases every hold", async () => {
    let fail = true
    const f = await fixture({ beforeDeleteSession: (_c, _directory, id) => {
      if (id === "root" && fail) throw new Error("document backend unavailable")
    } })
    try {
      await f.child("child")
      const response = await f.remove(f.selected())
      assert.equal(response.status, 500)
      assert.deepEqual((await response.json()).error, {
        code: "session_delete_failed", message: "Session deletion stopped before all effects completed",
        details: { sessionId: "root", deletedSessionIds: ["child"] },
      })
      assert.equal(f.store.getSession("child"), null)
      assert.ok(f.store.getSession("root"))
      assert.equal(f.store.readTurnAuthority("root"), undefined)
      assert.equal(f.store.readTurnAuthority("child"), undefined)
      fail = false
      assert.equal((await f.remove(f.selected())).status, 200)
    } finally { await f.dispose() }
  })

  void it("retains a finished parent's durable admission until its child creation settles", async () => {
    let blocked = false, entered!: () => void, release!: () => void
    const starting = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const control = controlledTurn("root")
    const host = createHostFixture({ transports: { pi: new FakeTransport({
      turn: () => control.events, beforeCapabilities: async () => { if (blocked) { entered(); await held } },
    }) } })
    try {
      await host.runtime.sessions.create(sessionCreate({ id: "root" }))
      await host.runtime.turns.start({ sessionId: "root", text: "work", origin: sessionCreate().origin })
      blocked = true
      const child = host.runtime.sessions.create({ ...sessionCreate({ id: "child" }), parentID: "root" })
      await starting
      control.finish()
      await until(() => host.store.getSession("root")?.status === "idle")
      const competing = createTurnAdmissions(host.store)
      assert.equal(competing.holdIdle("root"), undefined)
      assert.ok(host.store.readTurnAuthority("root"))
      assert.equal(host.runtime.recovery.inspect("root").target, undefined)
      assert.equal(host.store.getSession("child"), null)
      release()
      await child
      await until(() => host.store.readTurnAuthority("root") === undefined)
      const next = competing.holdIdle("root")
      assert.ok(next)
      next.release()
      assert.deepEqual(host.store.sessionDescendants("root"), ["child"])
    } finally { release(); control.finish(); await host.dispose() }
  })
})

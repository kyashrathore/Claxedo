import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { SessionAttentionPage } from "@claxedo/agent-runtime-contract"
import { createHostFixture, sessionCreate } from "../test-support/host-fixture"
import { FakeTransport } from "../test-support/fake-transport"
import { managedWorkspaceSessionAccessPolicy } from "../session-access-policy"
import { questionAsked, questionReplied, permissionAsked, sessionError } from "../projection/presentation-events"
import { createSessionRoutes } from "./session-core"
import type { SessionRouteOptions } from "./session-route-options"

async function fixture(options: Partial<SessionRouteOptions> = {}) {
  const host = createHostFixture({ transports: { pi: new FakeTransport() } })
  await host.runtime.sessions.create(sessionCreate({ id: "root" }))
  const app = createSessionRoutes({ runtime: async () => host.runtime,
    defaultHarness: () => ({ id: "pi", access: "native" }), requestedSessionHarness: () => undefined,
    resolveDirectory: () => "/repo", sessionIdWorkspace: () => "ws", publishGlobal: () => {}, ...options })
  return { ...host, app }
}

void describe("public session attention history", () => {
  void it("replays transient requests once in journal order after their pending state cleared", async () => {
    const f = await fixture()
    try {
      f.store.appendEvent({ sessionId: "root", payload: questionAsked({ sessionID: "root", id: "q1", questions: [] }) })
      f.store.appendEvent({ sessionId: "root", payload: questionReplied("root", "q1", []) })
      f.store.appendEvent({ sessionId: "root", payload: permissionAsked({ sessionID: "root", id: "p1", permission: "edit", patterns: ["*"], always: [], metadata: {} }) })
      f.store.appendEvent({ sessionId: "root", payload: { id: "permission.replied:p1", type: "permission.replied", properties: { sessionID: "root", requestID: "p1", reply: "once" } } })
      f.store.appendEvent({ sessionId: "root", payload: sessionError("Failed after requests", "root") })
      assert.equal(f.store.getSession("root")!.attention!.awaitingInput, false)
      const firstReply = await f.app.request("/session/root/attention?after=0&limit=2")
      assert.equal(firstReply.status, 200)
      assert.equal(firstReply.headers.get("cache-control"), "no-store")
      const first = await firstReply.json() as SessionAttentionPage
      assert.deepEqual(first.events.map(event => ({ kind: event.kind, requestId: event.requestId })), [{ kind: "question", requestId: "q1" }, { kind: "permission", requestId: "p1" }])
      assert.equal(first.next, first.events[1].sequence)
      const rest = await (await f.app.request(`/session/root/attention?after=${first.next}&limit=2`)).json() as SessionAttentionPage
      assert.equal(rest.events.length, 1)
      assert.equal(rest.events[0].kind, "outcome")
      assert.equal(rest.events[0].outcome, "failed")
      assert.equal(rest.events[0].sequence, f.store.getSession("root")!.attention!.outcome!.sequence)
      assert.equal(rest.next, undefined)
      const replayed = await (await f.app.request(`/session/root/attention?after=${rest.through}`)).json() as SessionAttentionPage
      assert.deepEqual(replayed.events, [])
    } finally { await f.dispose() }
  })

  void it("validates the complete cursor boundary and reports missing sessions", async () => {
    const f = await fixture()
    try {
      for (const query of ["after=-1", "after=1.2", "after=9007199254740992", "limit=0", "limit=257", "limit=two"]) {
        const response = await f.app.request(`/session/root/attention?${query}`)
        assert.equal(response.status, 400, query)
      }
      const ahead = await f.app.request(`/session/root/attention?after=${f.store.getSession("root")!.attention!.sequence + 1}`)
      assert.equal(ahead.status, 409)
      assert.equal((await ahead.json() as { error: { code: string } }).error.code, "invalid_attention_cursor")
      const missing = await f.app.request("/session/missing/attention")
      assert.equal(missing.status, 404)
      assert.equal((await missing.json() as { error: { code: string } }).error.code, "session_not_found")
    } finally { await f.dispose() }
  })

  void it("authorizes session metadata before reading history or leaking request identities", async () => {
    const operations: string[] = []
    const f = await fixture({ sessionAccessPolicy: { ...managedWorkspaceSessionAccessPolicy(), authorize: async input => {
      operations.push(`${input.operation}:${input.sessionId}`)
      return { allowed: false, status: 403, code: "session_access_denied", message: "Private session" }
    } } })
    try {
      f.store.appendEvent({ sessionId: "root", payload: questionAsked({ sessionID: "root", id: "secret-request", questions: [] }) })
      const response = await f.app.request("/session/root/attention")
      assert.equal(response.status, 403)
      assert.deepEqual(operations, ["session_meta_read:root"])
      assert.equal((await response.text()).includes("secret-request"), false)
    } finally { await f.dispose() }
  })
})

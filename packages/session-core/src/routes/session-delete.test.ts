import { afterEach, describe, expect, test } from "bun:test"
import { HTTPException } from "hono/http-exception"
import type { AgentEventEnvelope, SessionHarness } from "@claxedo/agent-runtime-contract"
import type { TurnRequest } from "@claxedo/harness/contract"
import { FakeTransport } from "../test-support/fake-transport"
import { createHostFixture, LOOPBACK_ORIGIN, sessionCreate, type HostFixture } from "../test-support/host-fixture"
import { testLaunch } from "../test-support/host-composition"
import { createSessionRoutes } from "./session-core"

const CODEX: SessionHarness = { id: "codex", access: "native" }
const WORKSPACE = "/workspace"

const hosts: HostFixture[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose()
})

const question = (sessionID: string): TurnRequest => ({
  kind: "question", requestId: `question_${sessionID}`,
  question: { id: `question_${sessionID}`, sessionID, questions: [{ question: "Continue?", header: "Continue?", options: [{ label: "yes", description: "go" }] }] },
})

/**
 * A real runtime over one scripted harness. A turn on a session named in
 * `holding` runs until the test releases it; a turn whose text is "ask" waits
 * on a question.
 */
function deleteFixture(hooks: { beforeDeleteSession?: (sessionId: string) => void } = {}) {
  const closed: string[] = []
  const events: AgentEventEnvelope[] = []
  const holding = new Map<string, () => void>()
  const transport = new FakeTransport({
    kind: "codex-app-server",
    capabilities: { requests: { permissions: false, questions: true, elicitation: false } },
    onClose: (session) => { closed.push(session.binding.sessionId) },
    turn: async function* ({ session, turn, broker }) {
      const sessionId = session.binding.sessionId
      const text = turn.prompt.parts.map((part) => ("text" in part ? part.text : "")).join("")
      if (text === "ask") await broker.ask(question(sessionId))
      else await new Promise<void>((resolve) => { holding.set(sessionId, resolve) })
      yield { type: "finish", sessionId }
    },
  })
  const host = createHostFixture({ transports: { codex: transport }, workspaceId: "ws_1", launch: testLaunch("ws_1") })
  hosts.push(host)
  const app = createSessionRoutes({
    sessionIdWorkspace: () => undefined,
    runtime: async () => host.runtime,
    defaultHarness: () => CODEX,
    requestedSessionHarness: () => undefined,
    resolveDirectory: () => WORKSPACE,
    resolveWorkspaceId: () => "ws_1",
    publishGlobal: (event) => { events.push(event) },
    ...(hooks.beforeDeleteSession ? { beforeDeleteSession: (_c, _directory, sessionId) => hooks.beforeDeleteSession!(sessionId) } : {}),
  })
  const seed = async (id: string, parentID?: string) => {
    await host.runtime.sessions.create({ ...sessionCreate({ id, workspaceId: "ws_1", directory: WORKSPACE, harness: CODEX }), ...(parentID ? { parentID } : {}) })
  }
  const run = async (sessionId: string, text = "work") => {
    await host.runtime.turns.start({ sessionId, parts: [{ type: "text", text }], origin: LOOPBACK_ORIGIN })
  }
  const remove = async (sessionId: string) => {
    const response = await app.request(`http://localhost/session/${sessionId}`, { method: "DELETE" })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  return { app, host, store: host.store, closed, events, holding, seed, run, remove }
}

async function eventually(condition: () => boolean) {
  for (let attempt = 0; attempt < 400 && !condition(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(condition()).toBe(true)
}

describe("DELETE /session/:id", () => {
  test("removes the whole tree leaf-first and names every session it removed", async () => {
    const f = deleteFixture()
    await f.seed("parent")
    await f.seed("child", "parent")
    await f.seed("grandchild", "child")

    expect(await f.remove("parent")).toEqual({ status: 200, body: { ok: true, deletedSessionIds: ["grandchild", "child", "parent"] } })
    expect(f.closed).toEqual(["grandchild", "child", "parent"])
    expect(f.events.map((event) => event.payload)).toEqual([
      { type: "session.deleted", properties: { info: { id: "grandchild", directory: WORKSPACE, parentID: "child" } } },
      { type: "session.deleted", properties: { info: { id: "child", directory: WORKSPACE, parentID: "parent" } } },
      { type: "session.deleted", properties: { info: { id: "parent", directory: WORKSPACE } } },
    ])
    for (const id of ["parent", "child", "grandchild"]) expect(f.store.getSession(id)).toBeNull()
  })

  test("refuses the whole tree while any session in it is working, and holds none of it afterwards", async () => {
    const f = deleteFixture()
    await f.seed("parent")
    await f.seed("child", "parent")
    await f.run("child")
    await eventually(() => f.holding.has("child"))

    expect(await f.remove("parent")).toEqual({
      status: 409,
      body: { error: { code: "session_delete_refused", message: "Session child is working", details: { sessionId: "child", reason: "working" } } },
    })
    expect(f.closed).toEqual([])
    expect(f.store.getSession("parent")).not.toBeNull()
    await f.run("parent")
    await eventually(() => f.holding.has("parent"))

    for (const id of ["child", "parent"]) {
      f.holding.get(id)!()
      ;(await f.host.runtime.turns.whenIdle(id)).abandon()
    }
    expect(await f.remove("parent")).toMatchObject({ status: 200, body: { deletedSessionIds: ["child", "parent"] } })
  })

  test("refuses a session that is waiting for input", async () => {
    const f = deleteFixture()
    await f.seed("asking")
    await f.run("asking", "ask")
    await eventually(() => f.store.listQuestions(WORKSPACE).length === 1)

    expect(await f.remove("asking")).toMatchObject({ status: 409, body: { error: { details: { sessionId: "asking", reason: "awaiting_input" } } } })
    expect(f.store.getSession("asking")).not.toBeNull()
    expect((await f.app.request("http://localhost/question/question_asking/reject", { method: "POST" })).status).toBe(200)
    ;(await f.host.runtime.turns.whenIdle("asking")).abandon()
    expect(await f.remove("asking")).toMatchObject({ status: 200 })
  })

  test("a failing hook ends the removal and names the sessions already removed", async () => {
    const f = deleteFixture({ beforeDeleteSession: (sessionId) => { if (sessionId === "parent") throw new Error("projection refused") } })
    await f.seed("parent")
    await f.seed("child", "parent")

    expect(await f.remove("parent")).toEqual({
      status: 500,
      body: { error: { code: "session_delete_failed", message: "projection refused", details: { sessionId: "parent", deletedSessionIds: ["child"] } } },
    })
    expect(f.store.getSession("child")).toBeNull()
    expect(f.store.getSession("parent")).not.toBeNull()
    expect(await f.remove("parent")).toMatchObject({ status: 500 })
  })

  test("a hook's own refusal keeps its status and still names what was removed", async () => {
    const f = deleteFixture({ beforeDeleteSession: (sessionId) => {
      if (sessionId === "parent") throw new HTTPException(409, { message: "Session parent still has running work" })
    } })
    await f.seed("parent")
    await f.seed("child", "parent")

    expect(await f.remove("parent")).toMatchObject({ status: 409, body: { error: { details: { sessionId: "parent", deletedSessionIds: ["child"] } } } })
  })

  test("answers 404 for a session the runtime does not hold", async () => {
    expect(await deleteFixture().remove("missing")).toMatchObject({ status: 404, body: { error: { code: "session_not_found" } } })
  })
})

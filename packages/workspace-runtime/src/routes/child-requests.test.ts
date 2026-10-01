import { afterEach, expect, test } from "bun:test"
import type { SubagentObservation } from "@claxedo/agent-runtime-contract"
import { permissionRequest, questionRequest, type RequestAnswer, type SessionBroker, type TurnBroker, type TurnRequest } from "@claxedo/harness/contract"
import type { SessionAccessPolicy } from "../session-access-policy"
import { FakeTransport } from "../test-support/fake-transport"
import { createHostFixture, controlledTurn, sessionCreate, until, LOOPBACK_ORIGIN, type HostFixture } from "../test-support/host-fixture"
import { createSessionRoutes } from "./session-core"

const PI = { id: "pi", access: "native" } as const
const REQUESTS = { requests: { permissions: true, questions: true, elicitation: false } }
const hosts: HostFixture[] = []

afterEach(async () => { for (const host of hosts.splice(0)) await host.dispose() })

const spawn = (toolCallId: string, mode: "foreground" | "background" = "foreground", status: SubagentObservation["status"] = "running"): SubagentObservation => ({
  observationId: `spawn:${toolCallId}:${status}`, providerKind: "claude-agent", toolCallId, toolCallRole: "spawn",
  status, mode, transcript: { kind: "live" },
})

function routes(f: HostFixture, sessionAccessPolicy?: SessionAccessPolicy) {
  return createSessionRoutes({
    runtime: async () => f.runtime, defaultHarness: () => PI, requestedSessionHarness: () => undefined,
    resolveDirectory: () => "/repo", resolveWorkspaceId: () => "ws", publishGlobal: () => {},
    ...(sessionAccessPolicy ? { sessionAccessPolicy } : {}),
  })
}

function onlySessions(allowed: () => readonly string[]): SessionAccessPolicy {
  const decide = (sessionId: string | undefined) => sessionId && allowed().includes(sessionId) ? { allowed: true as const }
    : { allowed: false as const, status: 403 as const, code: "session_forbidden", message: "Not yours" }
  return {
    sessionAuthority: "local",
    authorize: (input) => decide(input.sessionId),
    filterSessions: (input) => input.sessionIds.filter((id) => allowed().includes(id)),
    authorizePrefix: () => ({ allowed: true }),
    authorizeSessionStart: () => ({ allowed: true }),
    authorizeSessionStartStatus: () => ({ allowed: true }),
  }
}

const post = (app: ReturnType<typeof routes>, path: string, body: unknown) => app.request(`http://localhost${path}`,
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

async function childAsking(asks: ((broker: TurnBroker) => Promise<RequestAnswer>)[], mode: "foreground" | "background" = "foreground") {
  const control = controlledTurn("parent")
  const answers: RequestAnswer[] = []
  const children: string[] = []
  const transport = new FakeTransport({ capabilities: REQUESTS, turn: ({ broker }) => (async function* () {
    for (const key of ["toolu_agent", "toolu_sibling"]) {
      const child = await broker.observeSubagent(spawn(key, mode))
      broker.associateChild(key, child!)
      children.push(child!.sessionId)
    }
    for (const ask of asks) void ask(broker).then((answer) => { answers.push(answer) })
    yield* control.events
  })() })
  const f = createHostFixture({ transports: { pi: transport } })
  hosts.push(f)
  await f.runtime.sessions.create(sessionCreate({ id: "parent" }))
  await f.runtime.turns.start({ sessionId: "parent", text: "work", origin: LOOPBACK_ORIGIN })
  await until(() => f.store.listPermissions("/repo").length + f.store.listQuestions("/repo").length === asks.length, "child requests filed")
  return { f, app: routes(f), control, answers, child: children[0], sibling: children[1] }
}

const askedByChild = (request: TurnRequest, correlationKey: string): TurnRequest => ({ ...request, child: { correlationKey } })
const childPermission = (broker: TurnBroker) => broker.ask(askedByChild(permissionRequest({ sessionId: "parent", requestId: "perm",
  permission: "bash", title: "ls", patterns: ["ls"] }), "toolu_agent"))
const childQuestion = (broker: TurnBroker) => broker.ask(askedByChild(questionRequest({ sessionId: "parent", requestId: "ask",
  questions: [{ header: "Pick", question: "Which?", options: [{ label: "a", description: "" }] }] }), "toolu_agent"))

test("a subagent's permission is listed on its child and answered only through the child's route", async () => {
  const { f, app, control, answers, child, sibling } = await childAsking([childPermission])
  try {
    expect(await (await app.request("http://localhost/permission")).json()).toMatchObject([{ id: "perm", sessionID: child }])
    for (const other of ["parent", sibling]) {
      const refused = await post(app, `/session/${other}/permissions/perm`, { response: "once" })
      expect(refused.status).toBe(409)
      expect(await refused.json()).toMatchObject({ error: { code: "interaction_session_mismatch" } })
    }
    const foreign = createHostFixture({ transports: { pi: new FakeTransport({ capabilities: REQUESTS }) } })
    hosts.push(foreign)
    expect((await post(routes(foreign), `/session/${child}/permissions/perm`, { response: "once" })).status).toBe(404)
    expect(answers).toEqual([])
    expect((await post(app, `/session/${child}/permissions/perm`, { response: "once" })).status).toBe(200)
    await until(() => answers.length === 1, "harness released")
    expect(answers).toEqual([{ kind: "permission", decision: "allow_once" }])
    expect(f.store.listPermissions("/repo")).toEqual([])
  } finally { control.finish() }
})

test("a subagent's question is answered only on its child, whichever session the caller names", async () => {
  const { app, control, answers, child, sibling } = await childAsking([childQuestion])
  try {
    expect(await (await app.request("http://localhost/question")).json()).toMatchObject([{ id: "ask", sessionID: child }])
    for (const other of ["parent", sibling]) {
      expect((await post(app, `/question/ask/reply?sessionId=${other}`, { answers: [["a"]] })).status).toBe(409)
    }
    expect((await post(app, `/question/ask/reply?sessionId=${child}`, { answers: [["a"]] })).status).toBe(200)
    await until(() => answers.length === 1, "harness released")
    expect(answers).toEqual([{ kind: "answers", answers: [["a"]] }])
  } finally { control.finish() }
})

test("a background subagent's request asked during its parent's turn survives that turn's end and is answered on the child under the parent's authorization", async () => {
  const { f, control, answers, child, sibling } = await childAsking([childPermission, childQuestion], "background")
  control.finish()
  ;(await f.runtime.turns.whenIdle("parent")).abandon()
  expect(answers).toEqual([])
  expect(f.store.listPermissions("/repo").map((row) => row.sessionID)).toEqual([child])
  let allowed: readonly string[] = [child]
  const app = routes(f, onlySessions(() => allowed))
  expect((await post(app, `/session/${child}/permissions/perm`, { response: "once" })).status).toBe(403)
  allowed = ["parent"]
  for (const other of ["parent", sibling]) expect((await post(app, `/session/${other}/permissions/perm`, { response: "once" })).status).toBe(409)
  expect((await post(app, `/session/${child}/permissions/perm`, { response: "once" })).status).toBe(200)
  expect((await post(app, `/question/ask/reply?sessionId=${child}`, { answers: [["a"]] })).status).toBe(200)
  await until(() => answers.length === 2, "harness released")
  expect(answers).toContainEqual({ kind: "permission", decision: "allow_once" })
  expect(answers).toContainEqual({ kind: "answers", answers: [["a"]] })
})

test("a foreground subagent's pending requests are cancelled when its parent's turn ends, and a late answer is refused", async () => {
  const { f, app, control, answers, child } = await childAsking([childPermission, childQuestion])
  control.finish()
  ;(await f.runtime.turns.whenIdle("parent")).abandon()
  await until(() => answers.length === 2, "child requests cancelled")
  expect(answers).toEqual([{ kind: "cancelled" }, { kind: "cancelled" }])
  expect(f.store.listPermissions("/repo")).toEqual([])
  expect(f.store.listQuestions("/repo")).toEqual([])
  expect((await post(app, `/session/${child}/permissions/perm`, { response: "once" })).status).toBe(404)
  expect((await post(app, `/question/ask/reply?sessionId=${child}`, { answers: [["a"]] })).status).toBe(404)
})

async function idleParent() {
  const brokers = new Map<string, SessionBroker>()
  const children: string[] = []
  const transport = new FakeTransport({ capabilities: REQUESTS, beforeStart: async (input, broker) => { brokers.set(input.sessionId, broker) },
    turn: ({ broker }) => (async function* () {
      for (const key of ["toolu_agent", "toolu_sibling"]) {
        const child = await broker.observeSubagent(spawn(key, "background"))
        broker.associateChild(key, child!)
        children.push(child!.sessionId)
      }
      yield { type: "finish" as const, sessionId: "parent" }
    })() })
  const f = createHostFixture({ transports: { pi: transport } })
  hosts.push(f)
  await f.runtime.sessions.create(sessionCreate({ id: "parent" }))
  await f.runtime.turns.start({ sessionId: "parent", text: "work", origin: LOOPBACK_ORIGIN })
  ;(await f.runtime.turns.whenIdle("parent")).abandon()
  const answers: RequestAnswer[] = []
  const session = brokers.get("parent")!
  const ask = async (request: TurnRequest) => {
    const filed = f.store.listPermissions("/repo").length + f.store.listQuestions("/repo").length
    void session.ask(request).then((answer) => { answers.push(answer) })
    await until(() => f.store.listPermissions("/repo").length + f.store.listQuestions("/repo").length === filed + 1, "child request filed")
  }
  return { f, session, ask, answers, child: children[0], sibling: children[1] }
}

const idlePermission = askedByChild(permissionRequest({ sessionId: "parent", requestId: "idle-perm", permission: "bash", title: "ls", patterns: ["ls"] }), "toolu_agent")
const idleQuestion = askedByChild(questionRequest({ sessionId: "parent", requestId: "idle-ask",
  questions: [{ header: "Pick", question: "Which?", options: [{ label: "a", description: "" }] }] }), "toolu_agent")

test("a background subagent's request while its parent is idle is answered on its child and nowhere else", async () => {
  const { f, ask, answers, child, sibling } = await idleParent()
  const app = routes(f)
  expect(f.store.getSession("parent")?.status).not.toBe("busy")
  await ask(idlePermission)
  expect(await (await app.request("http://localhost/permission")).json()).toMatchObject([{ id: "idle-perm", sessionID: child }])
  for (const other of ["parent", sibling]) expect((await post(app, `/session/${other}/permissions/idle-perm`, { response: "once" })).status).toBe(409)
  const foreign = createHostFixture({ transports: { pi: new FakeTransport({ capabilities: REQUESTS }) } })
  hosts.push(foreign)
  expect((await post(routes(foreign), `/session/${child}/permissions/idle-perm`, { response: "once" })).status).toBe(404)
  expect(answers).toEqual([])
  expect((await post(app, `/session/${child}/permissions/idle-perm`, { response: "once" })).status).toBe(200)
  await until(() => answers.length === 1, "harness released")
  expect(answers).toEqual([{ kind: "permission", decision: "allow_once" }])
})

test("a per-task stop that settles the child cancels its pending request and refuses a late answer", async () => {
  const { f, session, ask, answers, child } = await idleParent()
  await ask(idleQuestion)
  await session.observeSubagent(spawn("toolu_agent", "background", "killed"))
  await until(() => answers.length === 1, "child request cancelled")
  expect(answers).toEqual([{ kind: "cancelled" }])
  expect(f.store.getSession(child)?.lastTurn?.status).toBe("cancelled")
  expect((await post(routes(f), `/question/idle-ask/reply?sessionId=${child}`, { answers: [["a"]] })).status).toBe(404)
})

test("a child's request is listed and answered under its parent's authorization, never the child's own", async () => {
  const { f, ask, answers, child } = await idleParent()
  await ask(idlePermission)
  await ask(idleQuestion)
  let allowed: readonly string[] = [child]
  const app = routes(f, onlySessions(() => allowed))
  expect(await (await app.request("http://localhost/permission")).json()).toEqual([])
  expect(await (await app.request("http://localhost/question")).json()).toEqual([])
  expect((await post(app, `/session/${child}/permissions/idle-perm`, { response: "once" })).status).toBe(403)
  expect((await post(app, `/question/idle-ask/reply?sessionId=${child}`, { answers: [["a"]] })).status).toBe(403)
  expect(answers).toEqual([])
  allowed = ["parent"]
  expect(await (await app.request("http://localhost/permission")).json()).toMatchObject([{ id: "idle-perm", sessionID: child }])
  expect((await post(app, `/session/${child}/permissions/idle-perm`, { response: "once" })).status).toBe(200)
  expect((await post(app, `/question/idle-ask/reply?sessionId=${child}`, { answers: [["a"]] })).status).toBe(200)
  await until(() => answers.length === 2, "harness released")
})

import { afterEach, expect, test } from "bun:test"
import type { SubagentObservation } from "@claxedo/agent-runtime-contract"
import { permissionRequest, questionRequest, type RequestAnswer, type TurnBroker, type TurnRequest } from "@claxedo/harness/contract"
import { FakeTransport } from "../test-support/fake-transport"
import { createHostFixture, controlledTurn, sessionCreate, until, LOOPBACK_ORIGIN, type HostFixture } from "../test-support/host-fixture"
import { createSessionRoutes } from "./session-core"

const PI = { id: "pi", access: "native" } as const
const REQUESTS = { requests: { permissions: true, questions: true, elicitation: false } }
const hosts: HostFixture[] = []

afterEach(async () => { for (const host of hosts.splice(0)) await host.dispose() })

const spawn = (toolCallId: string): SubagentObservation => ({
  observationId: `spawn:${toolCallId}`, providerKind: "claude-agent", toolCallId, toolCallRole: "spawn",
  status: "running", mode: "foreground", transcript: { kind: "live" },
})

function routes(f: HostFixture) {
  return createSessionRoutes({
    runtime: async () => f.runtime, defaultHarness: () => PI, requestedSessionHarness: () => undefined,
    resolveDirectory: () => "/repo", resolveWorkspaceId: () => "ws", publishGlobal: () => {},
  })
}

const post = (app: ReturnType<typeof routes>, path: string, body: unknown) => app.request(`http://localhost${path}`,
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

async function childAsking(asks: ((broker: TurnBroker) => Promise<RequestAnswer>)[]) {
  const control = controlledTurn("parent")
  const answers: RequestAnswer[] = []
  const children: string[] = []
  const transport = new FakeTransport({ capabilities: REQUESTS, turn: ({ broker }) => (async function* () {
    for (const key of ["toolu_agent", "toolu_sibling"]) {
      const child = await broker.observeSubagent(spawn(key))
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
  return { f, app: routes(f), control, answers, child: children[0]!, sibling: children[1]! }
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

test("the parent turn's end cancels its subagent's pending requests, and a late answer is refused", async () => {
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

import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import type { AgentRuntimeEvent, SessionHarness } from "@claxedo/agent-runtime-contract"
import type { RoutedEvent } from "@claxedo/harness/contract"
import { TURN_AUTHORITY_LOST } from "../host/recovery"
import type { SessionAccessPolicy, SessionTurnLeaseDecision } from "../session-access-policy"
import { FakeTransport, type FakeTurn } from "../test-support/fake-transport"
import { testLaunch } from "../test-support/host-composition"
import { createHostFixture, sessionCreate, until, type HostFixture } from "../test-support/host-fixture"
import { createSessionRoutes } from "./session-core"
import { sessionStatusSnapshot } from "./session-status-snapshot"

const CODEX: SessionHarness = { id: "codex", access: "native" }
const WORKSPACE = "/workspace"
const SESSION = "ses_lost"

const hosts: HostFixture[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose()
})

async function* replyUntilStopped({ broker }: FakeTurn): AsyncIterable<AgentRuntimeEvent | RoutedEvent> {
  yield { type: "text-delta", delta: "a reply cut short" }
  await new Promise((resolve) => broker.signal.addEventListener("abort", resolve, { once: true }))
}

async function* reply({ session }: FakeTurn): AsyncIterable<AgentRuntimeEvent | RoutedEvent> {
  yield { type: "text-delta", delta: "the retry" }
  yield { type: "finish", sessionId: session.binding.sessionId }
}

function leaseAuthority(input: { ttlMs: number; renewTurn: SessionAccessPolicy["renewTurn"] }) {
  const acquired: string[] = []
  const policy: SessionAccessPolicy = {
    sessionAuthority: "managed-private",
    authorize: async () => ({ allowed: true }),
    authorizeSessionStart: async () => ({ allowed: true }),
    authorizeSessionStartStatus: async () => ({ allowed: true }),
    authorizePrefix: async () => ({ allowed: true }),
    filterSessions: async (row) => row.sessionIds,
    registerSession: async () => ({ allowed: true }),
    acquireTurn: async (row): Promise<SessionTurnLeaseDecision> => {
      acquired.push(row.turnId)
      const now = Date.now()
      return { allowed: true, turnId: row.turnId, leaseId: `lease_${row.turnId}`, fencingToken: acquired.length, acquiredAt: now, expiresAt: now + input.ttlMs }
    },
    renewTurn: input.renewTurn,
    releaseTurn: async () => ({ released: true }),
  }
  return policy
}

async function relayedHost(policy: SessionAccessPolicy) {
  let turns = 0
  const transport = new FakeTransport({
    kind: "codex-app-server",
    turn: (input) => ++turns === 1 ? replyUntilStopped(input) : reply(input),
  })
  const host = createHostFixture({ transports: { codex: transport }, workspaceId: "ws_1", launch: testLaunch("ws_1", ["actor_1"]) })
  hosts.push(host)
  await host.runtime.sessions.create(sessionCreate({ id: SESSION, workspaceId: "ws_1", directory: WORKSPACE, harness: CODEX }))
  const routes = createSessionRoutes({
    sessionIdWorkspace: () => undefined,
    runtime: async () => host.runtime,
    defaultHarness: () => CODEX,
    requestedSessionHarness: () => undefined,
    resolveDirectory: () => WORKSPACE,
    resolveWorkspaceId: () => "ws_1",
    publishGlobal: () => {},
    getStatus: () => sessionStatusSnapshot(host.store.listSessions(WORKSPACE)),
    sessionAccessPolicy: policy,
  })
  const app = new Hono()
  app.use("*", async (context, next) => {
    ;(context as unknown as { set(name: string, value: unknown): void }).set("relayHostAuth", {
      actor_id: "actor_1", user_id: "actor_1", actor_kind: "human", org_id: "org_1", workspace_id: "ws_1", host_id: "host_1", role: "editor",
    })
    await next()
  })
  app.route("/", routes)
  const prompt = (messageID: string, text: string) => app.request(`http://localhost/session/${SESSION}/prompt_async`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messageID, parts: [{ type: "text", text }] }),
  })
  const status = async () => ((await (await app.request("http://localhost/session/status")).json()) as Record<string, unknown>)[SESSION]
  const statuses: unknown[] = []
  void (async () => {
    for await (const event of host.runtime.events.subscribe({ sessionId: SESSION })) {
      if (event.payload.type === "session.status") statuses.push(event.payload.properties.status)
    }
  })()
  return { host, transport, prompt, status, statuses }
}

describe("a relayed turn whose lease is lost", () => {
  test("a refused renewal leaves the session interrupted with the reply kept, and the next prompt runs", async () => {
    const { host, transport, prompt, status, statuses } = await relayedHost(leaseAuthority({
      ttlMs: 400,
      renewTurn: async () => ({ allowed: false, status: 403, code: "session_access_denied", message: "denied" }),
    }))

    expect((await prompt("msg_cut", "start")).status).toBe(204)
    await until(() => transport.turns.length === 1, "the turn to reach the harness")
    expect(await status()).toEqual({ type: "busy" })
    await until(() => host.store.getSession(SESSION)?.status === "interrupted", "the session to leave busy")

    expect(await status()).toEqual({ type: "interrupted", message: TURN_AUTHORITY_LOST })
    expect(statuses).toContainEqual({ type: "interrupted", message: TURN_AUTHORITY_LOST })
    const reply = host.store.getMessages(SESSION).find((message) => message.info.role === "assistant")
    expect(reply?.parts.map((part) => part.type === "text" ? part.text : part.type)).toContain("a reply cut short")
    expect(host.store.turnEvidence(SESSION, "msg_cut").finished).toBe(false)

    expect((await prompt("msg_retry", "again")).status).toBe(204)
    await until(() => host.store.getSession(SESSION)?.status === "idle", "the retry to finish")
    expect(host.store.getSession(SESSION)?.lastTurn).toMatchObject({ status: "completed" })
  })

  test("a lease that runs out unrenewed is interrupted soon after its deadline", async () => {
    const ttlMs = 300
    const { host, prompt, status } = await relayedHost(leaseAuthority({ ttlMs, renewTurn: async () => await new Promise(() => {}) }))

    const admitted = Date.now()
    expect((await prompt("msg_expired", "start")).status).toBe(204)
    await until(() => host.store.getSession(SESSION)?.status === "interrupted", "the session to leave busy")

    expect(Date.now() - admitted).toBeGreaterThanOrEqual(ttlMs)
    expect(Date.now() - admitted).toBeLessThan(ttlMs + 1_500)
    expect(await status()).toEqual({ type: "interrupted", message: TURN_AUTHORITY_LOST })
  })
})

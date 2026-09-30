import { afterEach, expect, test } from "bun:test"
import { Hono } from "hono"
import type { ConnectionSecretAuthority } from "@claxedo/agent-runtime-contract"
import type { RuntimeConnectionDescriptor } from "../routes/config"
import { SessionRoutes } from "../routes/session"
import { managedWorkspaceSessionAccessPolicy } from "../session-access-policy"
import { FakeTransport } from "../test-support/fake-transport"
import { createHostFixture, sessionCreate, tempStoreRoot, until, type HostFixture } from "../test-support/host-fixture"
import type { RuntimeStore } from "../store"
import { openRuntimeStore } from "../store-file"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { createWorkspaceHost } from "./runtime"
import { fakeConnectionProvider } from "../test-support/fake-transport"
import { loopbackMachineLoginPolicy } from "../testing"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { withWorkspaceTarget } from "../target"
import { queuedPromptStore } from "./session-routes"
import { createWorkspaceTransports } from "./transports"

const runner = { id: "connection", access: "connection" as const }
const actor = { actorId: "actor_1", actorKind: "human" as const }
const workspaceAuthority = { managed: true as const, workspaceId: "ws", orgId: "org_1", role: "editor" as const }
const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fixture(input: { holdFirstTurn?: Promise<void>; store?: RuntimeStore } = {}) {
  const authorities: Array<ConnectionSecretAuthority | undefined> = []
  const turns: Array<string | undefined> = []
  const descriptor: RuntimeConnectionDescriptor = {
    connectionId: runner.id, providerKey: "fixture", enabled: true, configRevision: 1, config: {}, secretRefs: { token: "ref" },
  }
  const transports = createWorkspaceTransports({
    connections: () => new Map([[runner.id, descriptor]]),
    resolveSecrets: (_descriptor, _directory, { authority }) => {
      authorities.push(authority)
      return { secrets: { token: "leased" }, secretLeaseGeneration: authority?.kind === "turn" ? authority.lease : "request" }
    },
    composer: {
      builtIn: () => { throw new Error("unexpected native harness") },
      connection: () => new FakeTransport({ turn: async function* ({ turn }) {
        turns.push(turn.prompt.userMessageId)
        if (turns.length === 1) await input.holdFirstTurn
        yield { type: "finish", sessionId: "queued" }
      } }),
    },
  })
  const host: HostFixture = createHostFixture({ transports, workspaceId: "ws", ...(input.store ? { store: input.store } : {}) })
  cleanups.push(() => transports.disposeAll(), () => host.dispose())
  const policy = managedWorkspaceSessionAccessPolicy({
    authority: {
      authorizeSessionStart: async () => true,
      authorizeSessionRead: async () => true,
      authorizeSessionWrite: async () => true,
      authorizeSessionStream: async () => ({ allowed: false, status: 503, code: "unused", message: "unused" }),
      registerSession: async () => true,
      acquireTurn: async (request) => ({
        allowed: true, turnId: request.turnId, leaseId: `signed-lease-for-${request.grant ?? "request"}`, fencingToken: 1,
        acquiredAt: Date.now(), expiresAt: Date.now() + 60_000,
      }),
      renewTurn: async (request) => ({
        allowed: true, turnId: request.turnId, leaseId: request.leaseId, fencingToken: request.fencingToken,
        acquiredAt: Date.now(), expiresAt: Date.now() + 60_000,
      }),
      releaseTurn: async () => ({ released: true }),
    },
  })
  policy.grantTurn = async (request) => ({ allowed: true, grant: `deferred-grant-${request.turnId}`, expiresAt: Date.now() + 60_000 })
  const routes = SessionRoutes(async () => host.runtime, {
    eventHub: host.eventHub,
    sessionAccessPolicy: policy,
    queuedPrompts: () => queuedPromptStore(host.store),
    requestedSessionHarness: (requested) => requested ?? runner,
  })
  cleanups.push(() => routes.dispose())
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("relayHostAuth" as never, { workspace_id: "ws", org_id: "org_1", role: "editor", actor_id: actor.actorId, actor_kind: actor.actorKind } as never)
    await next()
  })
  app.route("/", routes.routes)
  const relayed = (path: string, body: unknown) => app.request(path, { method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer relay-proof-of-this-request" }, body: JSON.stringify(body) })
  const relayedRead = (path: string) => app.request(path, { headers: { authorization: "Bearer relay-proof-of-this-read" } })
  return { host, routes, authorities, turns, relayed, relayedRead }
}

test("a relayed prompt recovered from the queue at mount leases its connection with its own turn lease, outside any request", async () => {
  const f = fixture()
  await f.host.runtime.sessions.create({ ...sessionCreate({ id: "queued", harness: runner, workspaceId: "ws" }),
    secretAuthority: { kind: "request", credential: "Bearer relay-proof-long-expired" } })
  f.host.store.deliveryQueue.queuePrompt({ sessionId: "queued", messageId: "msg_queued", parts: [{ type: "text", text: "then run the tests" }],
    delivery: "queue", actor, authority: workspaceAuthority, provenance: "relay-replayed", grant: "deferred-grant-1" })

  await f.routes.recoverQueuedPrompts()
  await until(() => f.turns.length > 0)

  expect(f.turns).toEqual(["msg_queued"])
  expect(f.authorities).toEqual([
    { kind: "request", credential: "Bearer relay-proof-long-expired" },
    { kind: "turn", lease: "signed-lease-for-deferred-grant-1" },
  ])
})

test("a relayed prompt queued behind a running turn is delivered later under its own turn lease, never the relay proof that queued it", async () => {
  let release!: () => void
  const f = fixture({ holdFirstTurn: new Promise<void>((resolve) => { release = resolve }) })
  cleanups.push(async () => release())
  await f.host.runtime.sessions.create({ ...sessionCreate({ id: "queued", harness: runner, workspaceId: "ws" }),
    secretAuthority: { kind: "request", credential: "Bearer relay-proof-of-create" } })
  expect((await f.relayed("/session/queued/prompt_async", { messageID: "msg_first", parts: [{ type: "text", text: "first" }] })).status).toBe(204)
  await until(() => f.turns.length === 1)
  const queued = await f.relayed("/session/queued/prompt_async", { messageID: "msg_later", delivery: "queue", parts: [{ type: "text", text: "later" }] })
  expect(queued.status, await queued.clone().text()).toBe(200)
  expect(f.host.store.deliveryQueue.listQueuedPrompts().map((row) => row.messageId)).toEqual(["msg_later"])

  release()
  await until(() => f.turns.length === 2)

  expect(f.turns).toEqual(["msg_first", "msg_later"])
  expect(f.authorities).toEqual([
    { kind: "request", credential: "Bearer relay-proof-of-create" },
    { kind: "turn", lease: "signed-lease-for-request" },
    { kind: "turn", lease: "signed-lease-for-deferred-grant-msg_later" },
  ])
})

test("after a restart, a session read attaches its connection under the relay proof of the read itself", async () => {
  const root = tempStoreRoot("secret-authority-restart-")
  const store = openRuntimeStore(root)
  cleanups.push(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  const before = fixture({ store })
  await before.host.runtime.sessions.create({ ...sessionCreate({ id: "restarted", harness: runner, workspaceId: "ws" }),
    secretAuthority: { kind: "request", credential: "Bearer relay-proof-of-create" } })
  await before.routes.dispose()
  await before.host.runtime.dispose()

  const after = fixture({ store })
  const read = await after.relayedRead("/session/restarted/capabilities")

  expect(read.status, await read.clone().text()).toBe(200)
  expect(after.authorities).toEqual([{ kind: "request", credential: "Bearer relay-proof-of-this-read" }])
})

test("registering session tools for a connection session no one has attached leases nothing", async () => {
  const directory = tempStoreRoot("secret-authority-tools-")
  const target = { workspaceId: "ws", directory }
  const refused: Array<ConnectionSecretAuthority | undefined> = []
  const boot = (resolveConnectionSecrets: Parameters<typeof createWorkspaceHost>[0]["resolveConnectionSecrets"]) => {
    const host = createWorkspaceHost({ target, placement: loopbackMachineLoginPolicy(), storeRoot: join(directory, "store"),
      harnessStateRoot: join(directory, "harness"), resolveConnectionSecrets,
      connectionProviders: [fakeConnectionProvider({ providerKey: "fixture", transport: () => new FakeTransport() })] })
    cleanups.push(() => host.dispose())
    return host
  }
  const snapshot = { version: 4 as const, commands: [], auth: { machineOwnerUserId: "local", accounts: {} }, mcp: {}, connections: [
    { connectionId: runner.id, providerKey: "fixture", configRevision: 1, enabled: true, config: {}, secretRefs: { token: "ref" } },
  ], defaultHarness: { kind: "connection" as const, connectionId: runner.id } }
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const first = boot(() => ({ secrets: { token: "leased" }, secretLeaseGeneration: "one" }))
  await first.apply(snapshot)
  const app = new Hono()
  first.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
  const created = await withWorkspaceTarget(target, () => app.request("/session", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "tools" }),
  }))
  expect(created.status, await created.clone().text()).toBe(201)
  await first.dispose()

  const restarted = boot(({ authority }) => { refused.push(authority); throw new Error("no proof for this lease") })
  await restarted.apply(snapshot)
  await restarted.registerSessionTools({ sessionId: "tools", callbackUrl: "http://127.0.0.1/tools",
    tools: [{ name: "lookup", description: "Looks something up", inputSchema: { type: "object" } }] })

  expect(refused).toEqual([])
})

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { afterAll, expect, test } from "bun:test"
import type { ProviderDirect } from "@claxedo/agent-runtime-contract"
import { releasePort, reservePort } from "../../e2e/harness/ports"
import { startScriptedModelServer } from "../../e2e/harness/scripted-model-server"
import { egressProxyEnv, startEgressGuard, unexpectedEgress, type EgressGuard } from "../../e2e/harness/egress-guard"
import { OpenCodeSdkTransport } from "../transports/opencode-sdk"
import type { CredentialRefreshRequest, RoutedEvent } from "../contract"
import { setupConformance, type ConformanceBackend } from "./test-support/run"
import { removeTempRoot } from "../test-support/temp-root"

type ScriptedServer = Awaited<ReturnType<typeof startScriptedModelServer>>
type PlanBackend = ConformanceBackend & { root: string; server: ScriptedServer; guard: EgressGuard }

const PLAN_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"]

let egress: Promise<EgressGuard> | undefined

function egressGuard(): Promise<EgressGuard> {
  egress ??= reservePort().then(startEgressGuard).then((guard) => {
    Object.assign(process.env, egressProxyEnv(guard.url))
    return guard
  })
  return egress
}

afterAll(async () => { await (await egress)?.close() })

const jwt = (claims: Record<string, unknown>) => ["none", claims].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".") + ".sig"

function planToken(tag: string, lifetimeSeconds = 3600): string {
  return jwt({ exp: Math.floor(Date.now() / 1000) + lifetimeSeconds, tag,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-member", chatgpt_plan_type: "plus" } })
}

function planRow(server: ScriptedServer, secret: string): ProviderDirect {
  return { delivery: "direct", baseUrl: server.url, apiPath: "/backend-api/codex", secret, authKind: "subscription",
    account: { credentialId: "plan-1", providerId: "codex-app-server", label: "member@example.com" } }
}

async function planBackend(secret: string, renewed: (server: ScriptedServer) => ProviderDirect | undefined,
  refreshes: CredentialRefreshRequest[]): Promise<PlanBackend> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-plan-"))
  const directory = path.join(root, "work")
  await fs.mkdir(directory)
  const port = await reservePort()
  const server = await startScriptedModelServer({ port })
  const guard = await egressGuard()
  const attemptsBefore = guard.attempts.length
  return {
    execution: "in-process", root, directory, server, guard,
    harness: { id: "opencode", access: "native" }, model: { providerID: "openai", modelID: "gpt-5.5" },
    credentials: { machineLoginAllowed: false, accountOwner: "member", providers: {}, secrets: {}, leaseGeneration: "plan",
      direct: { "codex-app-server": planRow(server, secret) } },
    owner: { kind: "person", userId: "member" },
    unrunnableTurn: (turn) => turn,
    configureServices: (services) => {
      services.refreshCredential = async (request) => { refreshes.push(request); return renewed(server) }
    },
    close: async () => {
      const attempts = guard.attempts.slice(attemptsBefore)
      await server.close()
      releasePort(port)
      await removeTempRoot(root)
      expect(attempts.filter((attempt) => attempt.target.includes("auth.openai.com"))).toEqual([])
      expect(unexpectedEgress(attempts)).toEqual([])
    },
  }
}

function transport(services: ConstructorParameters<typeof OpenCodeSdkTransport>[0], backend: ConformanceBackend) {
  const { root } = backend as PlanBackend
  return new OpenCodeSdkTransport(services, { databasePath: path.join(root, "opencode.db"),
    configContent: JSON.stringify({ model: "openai/gpt-5.5", small_model: "openai/gpt-5.5" }) })
}

async function collect(context: Awaited<ReturnType<typeof setupConformance>>, message: string): Promise<RoutedEvent[]> {
  const events: RoutedEvent[] = []
  for await (const event of context.transport.send(context.session, context.turn(message), context.turnBroker())) events.push(event)
  return events
}

function replied(events: readonly RoutedEvent[], marker: string): boolean {
  return events.some((item) => item.event.type === "text-delta" && item.event.delta.includes(marker))
    && !events.some((item) => item.event.type === "error")
}

function modelRequests(server: ScriptedServer) {
  return server.requests.filter((request) => request.path.startsWith("/backend-api/codex/responses"))
}

async function expectNoTokenStored(root: string, tokens: readonly string[]): Promise<void> {
  const db = new Database(path.join(root, "opencode.db"), { readonly: true })
  try {
    const rows = db.query<{ value: string }, []>("select value from credential").all().map((row) => JSON.parse(row.value))
    expect(rows).toEqual([expect.objectContaining({ type: "oauth", refresh: "", metadata: { accountID: "acct-member" } })])
  } finally { db.close() }
  const files = (await fs.readdir(root)).filter((name) => name.startsWith("opencode.db"))
  for (const name of files) {
    const bytes = await fs.readFile(path.join(root, name), "latin1")
    for (const token of tokens) expect(bytes.includes(token)).toBe(false)
  }
}

test("a ChatGPT plan handed over directly runs OpenCode's own plan path with the delivered token, account and plan models", async () => {
  const first = planToken("first")
  const refreshes: CredentialRefreshRequest[] = []
  const context = await setupConformance({ name: "opencode-plan", backend: () => planBackend(first, () => undefined, refreshes),
    makeTransport: transport })
  try {
    const state = context.backend as PlanBackend
    expect(replied(await collect(context, "Reply with exactly this one token: PLANOPENCODE"), "PLANOPENCODE")).toBe(true)
    const requests = modelRequests(state.server)
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((request) => request.authorization === `Bearer ${first}` && request.account === "acct-member")).toBe(true)
    const openai = (await context.transport.providerCatalog!.providers(context.start)).find((entry) => entry.id === "openai")
    expect(openai?.connected).toBe(true)
    expect(openai?.models.map((model) => model.id)).toEqual(expect.arrayContaining(PLAN_MODELS))
    expect(openai?.models.map((model) => model.id)).not.toContain("gpt-5.5-pro")
    expect(openai?.models.map((model) => model.id)).not.toContain("gpt-4.1")
    await expectNoTokenStored(state.root, [first])
    expect(refreshes).toEqual([])
  } finally { await context.close() }
}, 60_000)

test("a refused plan token is renewed through the host and the turn retries on the renewed token", async () => {
  const first = planToken("first")
  const renewed = planToken("renewed", 7200)
  const refreshes: CredentialRefreshRequest[] = []
  const context = await setupConformance({ name: "opencode-plan-refused",
    backend: async () => {
      const state = await planBackend(first, (server) => planRow(server, renewed), refreshes)
      state.server.refuseAuthorization(first)
      return state
    }, makeTransport: transport })
  try {
    const state = context.backend as PlanBackend
    expect(replied(await collect(context, "Reply with exactly this one token: PLANRENEWED"), "PLANRENEWED")).toBe(true)
    expect(refreshes).toEqual([{ sessionId: "s1", credentialProviderId: "codex-app-server", rejectedExpiresAt: expect.any(Number) }])
    const requests = modelRequests(state.server)
    expect(requests[0]).toMatchObject({ authorization: `Bearer ${first}`, account: "acct-member" })
    expect(requests.at(-1)).toMatchObject({ authorization: `Bearer ${renewed}`, account: "acct-member" })
    await expectNoTokenStored(state.root, [first, renewed])
  } finally { await context.close() }
}, 60_000)

test("a plan token close to its expiry is renewed through the host before the model request", async () => {
  const stale = planToken("stale", 120)
  const fresh = planToken("fresh", 7200)
  const refreshes: CredentialRefreshRequest[] = []
  const context = await setupConformance({ name: "opencode-plan-due", backend: () => planBackend(stale, (server) => planRow(server, fresh), refreshes),
    makeTransport: transport })
  try {
    const state = context.backend as PlanBackend
    expect(replied(await collect(context, "Reply with exactly this one token: PLANDUE"), "PLANDUE")).toBe(true)
    expect(refreshes).toEqual([{ sessionId: "s1", credentialProviderId: "codex-app-server", rejectedExpiresAt: expect.any(Number) }])
    const requests = modelRequests(state.server)
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((request) => request.authorization === `Bearer ${fresh}`)).toBe(true)
    await expectNoTokenStored(state.root, [stale, fresh])
  } finally { await context.close() }
}, 60_000)

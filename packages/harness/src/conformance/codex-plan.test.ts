import fs from "node:fs/promises"
import path from "node:path"
import { expect, test } from "bun:test"
import type { ProviderDirect } from "@claxedo/agent-runtime-contract"
import { codexOptions, recordingBackend, type CodexBackend } from "../../e2e/harness/codex-conformance"
import { CodexAppServerTransport } from "../transports/codex-app-server"
import type { CredentialRefreshRequest } from "../contract"
import { setupConformance } from "./test-support/run"

const jwt = (claims: Record<string, unknown>) => ["none", claims].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".") + ".sig"

function planToken(tag: string, lifetimeSeconds = 3600): string {
  return jwt({ exp: Math.floor(Date.now() / 1000) + lifetimeSeconds, email: "member@example.com", tag,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-member", chatgpt_plan_type: "plus" } })
}

function planRow(state: CodexBackend, secret: string): ProviderDirect {
  return { delivery: "direct", baseUrl: state.server.url, apiPath: "/backend-api/codex", secret, authKind: "subscription",
    expiresAt: Date.now() + 60 * 60 * 1000, account: { credentialId: "plan-1", providerId: "codex-app-server", label: "member@example.com" } }
}

async function collect(stream: AsyncIterable<{ event: { type: string } }>): Promise<string[]> {
  const types: string[] = []
  for await (const item of stream) types.push(item.event.type)
  return types
}

test("a ChatGPT plan handed over directly signs the real Codex in with its tokens, and a refused token is renewed through the host", async () => {
  const first = planToken("first")
  const renewed = planToken("renewed", 7200)
  const refreshes: CredentialRefreshRequest[] = []
  const recorder = recordingBackend()
  const context = await setupConformance({
    name: "codex-plan",
    backend: async () => {
      const state = await recorder.backend()
      state.server.refuseAuthorization(first)
      return { ...state, owner: { kind: "person", userId: "member" },
        credentials: { machineLoginAllowed: false, accountOwner: "member", providers: {}, direct: { "codex-app-server": planRow(state, first) }, secrets: {}, leaseGeneration: "plan" },
        configureServices: (services) => {
          state.configureServices?.(services)
          services.refreshCredential = async (request) => { refreshes.push(request); return planRow(state, renewed) }
        } }
    },
    makeTransport: (services, state) => new CodexAppServerTransport(services, codexOptions(state)),
  })
  try {
    const state = context.backend as CodexBackend
    expect(await collect(context.transport.send(context.session, context.turn("Reply with exactly this one token: PLANFIRST"), context.turnBroker())))
      .toContain("error")
    expect(refreshes).toEqual([{ sessionId: "s1", credentialProviderId: "codex-app-server", rejectedExpiresAt: expect.any(Number) }])
    await collect(context.transport.send(context.session, context.turn("Reply with exactly this one token: PLANSECOND"), context.turnBroker()))
    const model = state.server.requests.filter((request) => request.path.startsWith("/backend-api/codex/responses"))
    expect(model[0]).toMatchObject({ authorization: `Bearer ${first}`, account: "acct-member" })
    expect(model.at(-1)).toMatchObject({ authorization: `Bearer ${renewed}`, account: "acct-member" })
    expect(recorder.frames.filter((frame) => frame.method === "account/login/start").map((frame) => frame.params))
      .toEqual([{ type: "chatgptAuthTokens", accessToken: first, chatgptAccountId: "acct-member" }])
    const files = (await fs.readdir(path.join(state.root, "homes"), { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile())
    expect(files.some((entry) => entry.name === "auth.json")).toBe(false)
    for (const entry of files) {
      const text = await fs.readFile(path.join(entry.parentPath, entry.name), "latin1")
      expect(text.includes(first) || text.includes(renewed)).toBe(false)
    }
  } finally { await context.close() }
}, 90_000)

test("before a turn, a plan token whose own exp is close is renewed through the host and Codex signs in again", async () => {
  const stale = planToken("stale", 120)
  const fresh = planToken("fresh", 7200)
  const refreshes: CredentialRefreshRequest[] = []
  let turnRunning = false
  const recorder = recordingBackend()
  const context = await setupConformance({
    name: "codex-plan-due",
    backend: async () => {
      const state = await recorder.backend()
      return { ...state, owner: { kind: "person", userId: "member" },
        credentials: { machineLoginAllowed: false, accountOwner: "member", providers: {}, secrets: {}, leaseGeneration: "plan",
          direct: { "codex-app-server": planRow(state, stale) } },
        configureServices: (services) => {
          state.configureServices?.(services)
          services.refreshCredential = async (request) => {
            if (!turnRunning) return undefined
            refreshes.push(request)
            return planRow(state, fresh)
          }
        } }
    },
    makeTransport: (services, state) => new CodexAppServerTransport(services, codexOptions(state)),
  })
  try {
    const state = context.backend as CodexBackend
    turnRunning = true
    expect(await collect(context.transport.send(context.session, context.turn("Reply with exactly this one token: PLANDUE"), context.turnBroker())))
      .not.toContain("error")
    expect(refreshes).toEqual([{ sessionId: "s1", credentialProviderId: "codex-app-server", rejectedExpiresAt: expect.any(Number) }])
    expect(recorder.frames.filter((frame) => frame.method === "account/login/start").map((frame) => frame.params?.accessToken)).toEqual([stale, fresh])
    const model = state.server.requests.filter((request) => request.path.startsWith("/backend-api/codex/responses"))
    expect(model.length).toBeGreaterThan(0)
    expect(model.every((request) => request.authorization === `Bearer ${fresh}`)).toBe(true)
  } finally { await context.close() }
}, 90_000)

import { expect, test } from "bun:test"
import type { Query } from "@anthropic-ai/claude-agent-sdk"
import { createSessionTurnLifecycle } from "../shared/turn-lifecycle"
import type { SdkRuntimeDriverHost, SdkRuntimeTurnInput } from "../shared/sdk-runtime-driver"
import { createClaudeSdkDriver, type ClaudeSdkDriverOptions } from "./driver"

/**
 * An expired placeholder reaches the vendor as an ordinary bad token, and the
 * 401 it comes back with is attributed to the operator's stored account — so
 * the account a renewal failure broke is the one the operator is told to fix.
 */
function turn(): SdkRuntimeTurnInput {
  return {
    sessionId: "s1",
    getAgentSessionId: () => "claude-sdk:s1",
    input: {
      parts: [{ type: "text", text: "hello" }],
      assistantMessageId: "assistant-1",
      agent: "build",
      model: { providerID: "claude", modelID: "sonnet" },
    },
    directory: "/repo", abort: new AbortController(), ingest() {}, associateChild() {},
    observeSubagent: async () => ({ event: {} }), rebindAgentSession() {}, model: "sonnet",
  } as unknown as SdkRuntimeTurnInput
}

function host(overrides: Partial<SdkRuntimeDriverHost> = {}): SdkRuntimeDriverHost {
  return {
    lifecycle: () => createSessionTurnLifecycle(), pendingPermissions: new Map(), pendingQuestions: new Map(),
    bindSession() {}, getAgentSessionId: () => null, getSessionForAgentSession: () => null,
    getGoal: () => null, publishGoal() {}, runProviderTurn: async () => true,
    getSessionConfig: () => ({ harness: { id: "claude", access: "native" } }),
    updatePermissionState() {},
    ...overrides,
  }
}

function projection(expiresAt: number, placeholder = "placeholder-1") {
  return {
    "claude-sdk": {
      baseUrl: "http://127.0.0.1:2595/bindings/b1",
      placeholder,
      authMode: "bearer" as const,
      expiresAt,
    },
  }
}

function spawns() {
  const calls: Parameters<NonNullable<ClaudeSdkDriverOptions["query"]>>[0][] = []
  const query: NonNullable<ClaudeSdkDriverOptions["query"]> = (input) => {
    calls.push(input)
    return Object.assign((async function* () {})(), { close() {} }) as unknown as Query
  }
  return { calls, query }
}

test("a turn refuses to spawn on a placeholder whose lifetime has run out", async () => {
  const { calls, query } = spawns()
  const driver = createClaudeSdkDriver(host(), { query, executable: () => "/fake/claude" })
  await driver.applyConfig({ auth: projection(Date.now() - 1_000) })

  await expect(driver.runTurn(turn())).rejects.toThrow(/credential binding expired/)
  expect(calls).toHaveLength(0)
})

test("an expired placeholder is replaced by a renewal before the spawn, not after the vendor rejects it", async () => {
  const { calls, query } = spawns()
  let auth = projection(Date.now() - 1_000, "stale")
  const driver = createClaudeSdkDriver(
    host({ renewProjections: async () => { await driver.applyConfig({ auth }) } }),
    { query, executable: () => "/fake/claude" },
  )
  await driver.applyConfig({ auth })
  auth = projection(Date.now() + 60 * 60 * 1000, "renewed")

  await driver.runTurn(turn())

  expect(calls).toHaveLength(1)
  expect((calls[0].options!.env as Record<string, string>).ANTHROPIC_AUTH_TOKEN).toBe("renewed")
})

test("a renewal that does not produce a live placeholder refuses rather than spawning anyway", async () => {
  const { calls, query } = spawns()
  let renewals = 0
  const driver = createClaudeSdkDriver(
    host({ renewProjections: async () => { renewals++ } }),
    { query, executable: () => "/fake/claude" },
  )
  await driver.applyConfig({ auth: projection(Date.now() - 1_000) })

  await expect(driver.runTurn(turn())).rejects.toThrow(/credential binding expired/)
  expect(renewals).toBe(1)
  expect(calls).toHaveLength(0)
})

test("a live placeholder spawns without asking for a renewal", async () => {
  const { calls, query } = spawns()
  let renewals = 0
  const driver = createClaudeSdkDriver(
    host({ renewProjections: async () => { renewals++ } }),
    { query, executable: () => "/fake/claude" },
  )
  await driver.applyConfig({ auth: projection(Date.now() + 60 * 60 * 1000, "live") })

  await driver.runTurn(turn())

  expect(renewals).toBe(0)
  expect((calls[0].options!.env as Record<string, string>).ANTHROPIC_AUTH_TOKEN).toBe("live")
})

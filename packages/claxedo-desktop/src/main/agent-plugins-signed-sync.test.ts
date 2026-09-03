import { describe, expect, test } from "bun:test"
import { setupAgentPluginsSignedSync } from "./agent-plugins-signed-sync"

function harness(input: { status?: number; body?: unknown; daemonStatus?: number } = {}) {
  const operations: string[] = []
  const pushes: Array<string | null> = []
  const timers: Array<{ run: () => void; delayMs: number }> = []
  const sync = setupAgentPluginsSignedSync({
    enabled: true,
    runAccountOperation: async (name) => {
      operations.push(name)
      return { status: input.status ?? 200, body: input.body ?? { revision: 3, expiresAt: Date.now() + 30 * 60_000 } }
    },
    serverUrl: async () => "http://127.0.0.1:2593",
    request: async (_url, init) => {
      pushes.push(typeof init?.body === "string" ? init.body : null)
      return new Response(JSON.stringify({ active: true }), { status: input.daemonStatus ?? 200 })
    },
    log: { info: () => {}, warn: () => {} },
    setTimer: (run, delayMs) => {
      timers.push({ run, delayMs })
      return setTimeout(() => {}, 0)
    },
  })
  return { sync, operations, pushes, timers }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("signed Agent Plugins sync", () => {
  test("pulls the signed world on sign-in, hands it to the daemon, and schedules the refresh before the credential dies", async () => {
    const { sync, operations, pushes, timers } = harness()
    sync.follow({ status: "signed" })
    await settle()
    expect(operations).toEqual(["agentPlugins.runtimeSelf"])
    expect(pushes).toHaveLength(1)
    expect(JSON.parse(pushes[0]!)).toMatchObject({ revision: 3 })
    expect(timers).toHaveLength(1)
    expect(timers[0]!.delayMs).toBeLessThanOrEqual(10 * 60_000)
    expect(timers[0]!.delayMs).toBeGreaterThan(0)
  })

  test("withdraws the signed world when the account stops being signed and ignores repeats", async () => {
    const { sync, pushes } = harness()
    sync.follow({ status: "signed" })
    await settle()
    sync.follow({ status: "unavailable" })
    sync.follow({ status: "unsigned" })
    await settle()
    expect(pushes).toEqual([expect.any(String), "null"])
  })

  test("retries after a control-plane refusal instead of pushing a bad body", async () => {
    const { sync, pushes, timers } = harness({ status: 503, body: { error: { code: "down" } } })
    sync.follow({ status: "signed" })
    await settle()
    expect(pushes).toEqual([])
    expect(timers[0]!.delayMs).toBe(60_000)
  })

  test("refresh is a no-op while unsigned", async () => {
    const { sync, operations } = harness()
    await sync.refresh()
    expect(operations).toEqual([])
  })
})

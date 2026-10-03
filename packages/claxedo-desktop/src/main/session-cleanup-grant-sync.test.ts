import { describe, expect, test } from "bun:test"
import { CLAXEDO_DAEMON_PROTOCOL, DAEMON_PROTOCOL_HEADER } from "@claxedo/helpers/claxedo-daemon"
import type { AccountState } from "./account/account-service"
import { setupSessionCleanupGrantSync } from "./session-cleanup-grant-sync"
import { recordingDaemon } from "./test-support/daemon-fetch"

const NOW = 1_800_000_000_000
const CORE = "https://core.example"
const GRANT = { token: "scoped-cleanup-grant", expiresAt: NOW + 5 * 60_000, actorId: "actor_canonical", orgId: "org_1" }
const PENDING = { capability: null, unavailable: "Signed desktop cleanup grant is pending" }
const UNAVAILABLE = { capability: null, unavailable: "Signed desktop cleanup grant could not be issued" }
const signed = (userId = "display_user", orgId?: string): AccountState => ({ status: "signed", identity: { userId, ...(orgId ? { orgId } : {}) } })

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((finish) => { resolve = finish })
  return { promise, resolve }
}

function harness(input: {
  pull?: () => Promise<unknown>
  daemonStatus?: () => number
} = {}) {
  const operations: Array<{ name: string; params: unknown }> = []
  const timers: Array<{ run: () => void; delayMs: number; cancelled: boolean }> = []
  const warnings: string[] = []
  const { daemon, requests } = recordingDaemon({
    respond: () => Response.json({ ok: true, authenticated: true }, { status: input.daemonStatus?.() ?? 200 }),
  })
  const sync = setupSessionCleanupGrantSync({
    coreOrigin: CORE,
    runAccountOperation: async (name, params) => {
      operations.push({ name, params })
      return await (input.pull?.() ?? Promise.resolve(GRANT))
    },
    daemon,
    log: { info: () => {}, warn: (message) => warnings.push(message) },
    now: () => NOW,
    setTimer: (run, delayMs) => {
      const timer = { run, delayMs, cancelled: false }
      timers.push(timer)
      return timer as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (timer) => { (timer as unknown as typeof timers[number]).cancelled = true },
  })
  return { sync, operations, requests, timers, warnings }
}

async function settle() {
  for (let index = 0; index < 30; index++) await Promise.resolve()
}

describe("main's signed desktop cleanup grant", () => {
  test("installs the issuer's actor/org and configured origin without a served workspace", async () => {
    const h = harness()
    h.sync.follow(signed())
    await h.sync.refresh()
    expect(h.operations).toEqual([{ name: "session.cleanup.grant.desktop", params: {} }])
    expect(h.requests.map((request) => request.body)).toEqual([
      PENDING, { capability: { ...GRANT, origin: CORE } },
    ])
    for (const request of h.requests) {
      expect(request.url).toBe("http://127.0.0.1:4000/api/claxedo/daemon/session-cleanup")
      expect(request.method).toBe("PUT")
      expect(request.capability).toBe("daemon-capability")
      expect(request.headers.get(DAEMON_PROTOCOL_HEADER)).toBe(String(CLAXEDO_DAEMON_PROTOCOL))
      expect(request.headers.get("authorization")).toBe("Bearer daemon-capability")
    }
    expect(h.timers[0]?.delayMs).toBe(4 * 60_000)
    await h.sync.stop()
  })

  test("clears a reused daemon during unsigned boot and mints nothing", async () => {
    const h = harness()
    h.sync.follow({ status: "unsigned" })
    await h.sync.refresh()
    expect(h.requests.map((request) => request.body)).toEqual([{ capability: null }])
    expect(h.operations).toEqual([])
    await h.sync.stop()
  })

  test("refreshes ahead of expiry and deduplicates concurrent refresh calls", async () => {
    const h = harness()
    h.sync.follow(signed())
    await h.sync.refresh()
    h.timers[0].run()
    await Promise.all([h.sync.refresh(), h.sync.refresh()])
    expect(h.operations).toHaveLength(2)
    expect(h.requests.map((request) => request.body)).toEqual([
      PENDING, { capability: { ...GRANT, origin: CORE } }, { capability: { ...GRANT, origin: CORE } },
    ])
    await h.sync.stop()
    expect(h.timers.at(-1)?.cancelled).toBe(true)
  })

  test.each<AccountState>([
    { status: "unsigned" }, { status: "pending" },
    { status: "unavailable", reason: "revoked", detail: "revoked" },
    { status: "unavailable", reason: "callback-failed", detail: "offline", transient: true },
  ])("withdraws on account auth loss: %j", async (next) => {
    const h = harness()
    h.sync.follow(signed())
    await h.sync.refresh()
    h.sync.follow(next)
    await h.sync.refresh()
    expect(h.requests.at(-1)?.body).toEqual({ capability: null })
    expect(h.timers[0]?.cancelled).toBe(true)
    expect(h.operations).toHaveLength(1)
    await h.sync.stop()
  })

  test("sign-out clears before a pending mint returns; its late grant is discarded", async () => {
    const pending = deferred<unknown>()
    const h = harness({ pull: () => pending.promise })
    h.sync.follow(signed())
    await settle()
    expect(h.operations).toHaveLength(1)
    h.sync.follow({ status: "unsigned" })
    await h.sync.refresh()
    expect(h.requests.map((request) => request.body)).toEqual([PENDING, { capability: null }])
    pending.resolve(GRANT)
    await settle()
    expect(h.requests).toHaveLength(2)
    expect(h.timers).toEqual([])
    await h.sync.stop()
  })

  test("a new account clears before minting and never adopts a previous account's late answer", async () => {
    const old = deferred<unknown>()
    let attempts = 0
    const replacement = { ...GRANT, token: "new-grant", actorId: "actor_new", orgId: "org_2" }
    const h = harness({ pull: async () => ++attempts === 1 ? await old.promise : replacement })
    h.sync.follow(signed("first", "org_1"))
    await settle()
    h.sync.follow(signed("second", "org_2"))
    await h.sync.refresh()
    expect(h.operations.map((operation) => operation.params)).toEqual([{ orgId: "org_1" }, { orgId: "org_2" }])
    expect(h.requests.map((request) => request.body)).toEqual([
      PENDING, PENDING, { capability: { ...replacement, origin: CORE } },
    ])
    old.resolve(GRANT)
    await settle()
    expect(h.requests).toHaveLength(3)
    await h.sync.stop()
  })

  test("repeated account display enrichment does not mint again", async () => {
    const h = harness()
    h.sync.follow(signed())
    await h.sync.refresh()
    h.sync.follow({ status: "signed", identity: { userId: "display_user", displayName: "Name" } })
    await settle()
    expect(h.operations).toHaveLength(1)
    await h.sync.stop()
  })

  test("an issuer failure withdraws the prior grant and retries while signed", async () => {
    let refused = false
    const h = harness({ pull: async () => { if (refused) throw new Error("HOSTED_HTTP 403 consent withdrawn"); return GRANT } })
    h.sync.follow(signed())
    await h.sync.refresh()
    refused = true
    await h.sync.refresh()
    expect(h.requests.at(-1)?.body).toEqual(UNAVAILABLE)
    expect(h.warnings[0]).toContain("403 consent withdrawn")
    expect(h.timers.at(-1)?.delayMs).toBe(60_000)
    refused = false
    h.timers.at(-1)!.run()
    await h.sync.refresh()
    expect(h.requests.at(-1)?.body).toEqual({ capability: { ...GRANT, origin: CORE } })
    await h.sync.stop()
  })

  test.each([
    { ...GRANT, expiresAt: NOW }, { ...GRANT, token: "" }, { ...GRANT, actorId: "" },
    { ...GRANT, orgId: "other" }, { ...GRANT, expiresAt: "tomorrow" },
  ])("refuses an expired or malformed issuer grant: %j", async (answer) => {
    const h = harness({ pull: async () => answer })
    h.sync.follow(signed("user", "org_1"))
    await h.sync.refresh()
    expect(h.requests.map((request) => request.body)).toEqual([PENDING, UNAVAILABLE])
    expect(h.warnings).toHaveLength(1)
    expect(h.timers[0]?.delayMs).toBe(60_000)
    await h.sync.stop()
  })

  test("a failed clear blocks minting until withdrawal succeeds, including while unsigned", async () => {
    let status = 503
    const h = harness({ daemonStatus: () => status })
    h.sync.follow(signed())
    await h.sync.refresh()
    expect(h.operations).toEqual([])
    expect(h.timers[0]?.delayMs).toBe(60_000)
    await h.sync.refresh()
    expect(h.operations).toEqual([])
    status = 200
    await h.sync.refresh()
    expect(h.operations).toHaveLength(1)
    status = 503
    h.sync.follow({ status: "unsigned" })
    await h.sync.refresh()
    expect(h.timers.at(-1)?.delayMs).toBe(60_000)
    status = 200
    h.timers.at(-1)!.run()
    await h.sync.refresh()
    expect(h.requests.at(-1)?.body).toEqual({ capability: null })
    expect(h.operations).toHaveLength(1)
    await h.sync.stop()
  })

  test("stop clears immediately while mint is pending and prevents its late install", async () => {
    const pending = deferred<unknown>()
    const h = harness({ pull: () => pending.promise })
    h.sync.follow(signed())
    await settle()
    await h.sync.stop()
    pending.resolve(GRANT)
    await settle()
    expect(h.requests.map((request) => request.body)).toEqual([PENDING, { capability: null }])
    expect(h.timers).toEqual([])
  })
})

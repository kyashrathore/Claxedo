import { describe, expect, test } from "vitest"
import type { CredentialMetadata, CredentialUsageWindow } from "@claxedo/server-core/credentials/types"
import { mergeWindow, recordReportedWindow, reportedWindow, type TurnUsageStore } from "./turn-usage"

function rateLimit(overrides: Record<string, unknown> = {}) {
  return {
    type: "rate-limit",
    status: "ok",
    usedPercent: 23,
    resetsAt: 1_757_700_000_000,
    limitId: "five_hour",
    limitName: "session",
    metadata: { harness: "claude", account: null },
    ...overrides,
  }
}

describe("the window a runtime event describes", () => {
  test("is read off a Claude rate-limit event", () => {
    expect(reportedWindow(rateLimit())).toEqual({
      harness: "claude",
      account: null,
      window: { window: "session", usedPercent: 23, resetsAt: 1_757_700_000_000 },
    })
  })

  test("names the binding the turn spawned on", () => {
    const report = reportedWindow(rateLimit({
      metadata: { harness: "claude", account: "http://127.0.0.1:2595/bindings/b1" },
    }))

    expect(report?.account).toBe("http://127.0.0.1:2595/bindings/b1")
  })

  test("is nothing for an event that names no window or no percentage", () => {
    expect(reportedWindow(rateLimit({ limitName: undefined }))).toBeUndefined()
    expect(reportedWindow(rateLimit({ usedPercent: undefined }))).toBeUndefined()
  })

  test("is nothing for another harness, another event, or a shapeless payload", () => {
    // Codex reports its own rate limits on this same bus and stores them from
    // its Check instead, so a harness this does not file for is passed over
    // rather than written under a machine login it does not name.
    expect(reportedWindow(rateLimit({ metadata: { harness: "codex", account: null } }))).toBeUndefined()
    expect(reportedWindow(rateLimit({ metadata: { codex: { rateLimits: {} } } }))).toBeUndefined()
    expect(reportedWindow({ type: "session-status", status: "idle" })).toBeUndefined()
    expect(reportedWindow(undefined)).toBeUndefined()
    expect(reportedWindow("rate-limit")).toBeUndefined()
  })
})

describe("merging a reported window into what an account holds", () => {
  const held: CredentialUsageWindow[] = [
    { window: "session", usedPercent: 10, resetsAt: 1 },
    { window: "weekly", usedPercent: 60, resetsAt: 2 },
  ]

  test("replaces that window and leaves the others standing", () => {
    expect(mergeWindow(held, { window: "session", usedPercent: 23, resetsAt: 9 })).toEqual([
      { window: "weekly", usedPercent: 60, resetsAt: 2 },
      { window: "session", usedPercent: 23, resetsAt: 9 },
    ])
  })

  test("adds a window the account has never reported", () => {
    expect(mergeWindow(held, { window: "weekly_opus", usedPercent: 5, resetsAt: null })).toHaveLength(3)
    expect(mergeWindow(null, { window: "session", usedPercent: 1, resetsAt: null }))
      .toEqual([{ window: "session", usedPercent: 1, resetsAt: null }])
  })
})

function store(overrides: Partial<TurnUsageStore> = {}) {
  const credentialWrites: Array<{ id: string; windows: readonly CredentialUsageWindow[]; at: number; org?: string }> = []
  const machineWrites: Array<{ harness: string; account: string; windows: readonly CredentialUsageWindow[]; at: number }> = []
  const machineRows = [{
    harness: "claude",
    account: "machine@acme.com",
    windows: [{ window: "weekly", usedPercent: 67, resetsAt: null }],
    at: 100,
  }]
  const credential = {
    id: "cred_1",
    usage_windows: [{ window: "weekly", usedPercent: 40, resetsAt: null }],
  } as CredentialMetadata
  const base: TurnUsageStore = {
    credentials: {
      getCredential: async (id) => (id === "cred_1" ? credential : undefined),
      updateCredentialUsage: async (id, windows, at, org) => { credentialWrites.push({ id, windows, at, org }) },
    },
    boundCredential: (baseUrl) => baseUrl.endsWith("/bindings/b1") ? { credentialId: "cred_1", orgId: "__local__" } : undefined,
    machineAccount: async () => "machine@acme.com",
    machineUsage: {
      readMachineLoginUsage: async () => machineRows,
      recordMachineLoginUsage: async (harness, account, windows, at) => { machineWrites.push({ harness, account, windows, at }) },
    },
    now: () => 1_000,
    ...overrides,
  }
  return { store: base, credentialWrites, machineWrites }
}

describe("storing a reported window", () => {
  const session: CredentialUsageWindow = { window: "session", usedPercent: 23, resetsAt: null }

  test("goes to the bound account the turn spawned on, beside the windows it already held", async () => {
    const { store: turnStore, credentialWrites, machineWrites } = store()

    await recordReportedWindow(turnStore, {
      harness: "claude",
      account: "http://127.0.0.1:2595/bindings/b1",
      window: session,
    })

    expect(credentialWrites).toEqual([{
      id: "cred_1",
      windows: [{ window: "weekly", usedPercent: 40, resetsAt: null }, session],
      at: 1_000,
      org: "__local__",
    }])
    expect(machineWrites).toEqual([])
  })

  test("goes to this machine's login under the address that harness names", async () => {
    const { store: turnStore, credentialWrites, machineWrites } = store()

    await recordReportedWindow(turnStore, { harness: "claude", account: null, window: session })

    expect(machineWrites).toEqual([{
      harness: "claude",
      account: "machine@acme.com",
      windows: [{ window: "weekly", usedPercent: 67, resetsAt: null }, session],
      at: 1_000,
    }])
    expect(credentialWrites).toEqual([])
  })

  test("writes nothing for a binding this server did not mint", async () => {
    const { store: turnStore, credentialWrites } = store()

    await recordReportedWindow(turnStore, { harness: "claude", account: "http://elsewhere/bindings/x", window: session })

    expect(credentialWrites).toEqual([])
  })

  test("swallows a store that refuses, because a turn must not die over a percentage", async () => {
    const { store: turnStore } = store({
      machineUsage: {
        readMachineLoginUsage: async () => { throw new Error("database is locked") },
        recordMachineLoginUsage: async () => {},
      },
    })

    expect(await recordReportedWindow(turnStore, { harness: "claude", account: null, window: session }))
      .toBeUndefined()
  })
})

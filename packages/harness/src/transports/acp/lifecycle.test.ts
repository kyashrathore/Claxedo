import { expect, test } from "bun:test"
import type { HarnessSession } from "../../contract"
import { AcpConnectionHealth } from "./health"
import type { AcpEntry } from "./index"
import { AcpSessionLifecycle } from "./lifecycle"
import { AcpPeerOwnership } from "./ownership"
import type { AcpHost } from "./startup"

function host(entry: AcpEntry) {
  const retired: string[] = []
  const peers = new AcpPeerOwnership()
  const health = new AcpConnectionHealth({ now: () => 1, setTimeout, clearTimeout }, () => {})
  const observation = health.begin("ses_1", "/work")
  observation.ready()
  entry.observation = observation
  entry.peer = {
    retire: async () => { retired.push("peer") },
    handshake: { agentCapabilities: entry.peer?.handshake.agentCapabilities ?? { sessionCapabilities: { resume: {} } } },
  } as unknown as AcpEntry["peer"]
  const entries = new Map([["ses_1", entry]])
  const lifecycle = new AcpSessionLifecycle({ entries, peers, health, disposed: () => false } as unknown as AcpHost)
  return { lifecycle, entries, retired, health }
}

function quiet(overrides: Partial<AcpEntry> = {}): AcpEntry {
  return {
    phase: "ready", pendingRestart: false, cancelled: false, startupAbort: new AbortController(),
    children: { hasLive: false }, sideSessions: new Map(),
    session: { binding: { sessionId: "ses_1", upstreamSessionId: "up_1" }, directory: "/work" },
    ...overrides,
  } as unknown as AcpEntry
}

const session = { binding: { sessionId: "ses_1", upstreamSessionId: "up_1" } } as HarnessSession

test("a quiescent ACP session is released: its peer retired, its entry and observation gone", async () => {
  const { lifecycle, entries, retired, health } = host(quiet())
  expect(await lifecycle.release(session)).toBe(true)
  expect(retired).toEqual(["peer"])
  expect(entries.size).toBe(0)
  expect(health.connection("/work").state).toBe("configured")
})

const live: Array<[string, Partial<AcpEntry>]> = [
  ["a running turn", { phase: "busy", turnBroker: {} as AcpEntry["turnBroker"] }],
  ["an uncertain outcome", { phase: "uncertain" }],
  ["an autonomous Goal turn", { providerTurn: {} as AcpEntry["providerTurn"] }],
  ["a startup still running", { startup: {} as AcpEntry["startup"] }],
  ["a configuration restart still pending", { pendingRestart: true }],
  ["a cancel still in flight", { cancelSent: Promise.resolve({ ok: true as const }) }],
  ["a live native child", { children: { hasLive: true } as AcpEntry["children"] }],
  ["a title side session", { sideSessions: new Map([["side", () => {}]]) }],
]

for (const [what, overrides] of live) test(`${what} refuses the release and keeps the session attached`, async () => {
  const { lifecycle, entries, retired } = host(quiet(overrides))
  expect(await lifecycle.release(session)).toBe(false)
  expect(retired).toEqual([])
  expect(entries.size).toBe(1)
})

test("an agent that declares neither resume nor load keeps its session attached", async () => {
  const { lifecycle, entries, retired } = host(quiet({ peer: { handshake: { agentCapabilities: {} } } as unknown as AcpEntry["peer"] }))
  expect(await lifecycle.release(session)).toBe(false)
  expect(retired).toEqual([])
  expect(entries.size).toBe(1)
})

test("a session that is not attached answers nothing to release", async () => {
  const { lifecycle } = host(quiet())
  expect(await lifecycle.release({ binding: { sessionId: "ses_other" } } as HarnessSession)).toBe(false)
})

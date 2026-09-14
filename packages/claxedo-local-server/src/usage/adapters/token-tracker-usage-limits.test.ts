import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { machineAgentUsage, readMachineAgentUsage } from "./token-tracker-usage-limits"

const library = vi.hoisted(() => ({ getUsageLimits: vi.fn(), resetUsageLimitsCache: vi.fn() }))
vi.mock("tokentracker-cli/src/lib/usage-limits.js", () => library)

const FETCHED_AT = "2026-09-13T12:00:00.000Z"
const CAPTURED_AT = "2026-09-13T11:59:00.000Z"

/**
 * One answer in the shape `getUsageLimits()` returns: a key per agent, each
 * carrying whichever window slots its vendor reports plus the bookkeeping
 * fields — provenance, plan label, staleness — that are not windows.
 */
const probe = {
  fetched_at: FETCHED_AT,
  claude: {
    configured: true,
    error: null,
    plan_label: "Max",
    five_hour: { used_percent: 25, reset_at: "2026-09-13T15:00:00.000Z" },
    seven_day: { used_percent: 60.4, reset_at: null },
    seven_day_opus: null,
    weekly_scoped: [{ label: "Opus", used_percent: 12, resets_at: "2026-09-20T00:00:00.000Z" }],
    stale: false,
    cached_at: CAPTURED_AT,
    provenance: { source: "provider-api", confidence: "official", captured_at: CAPTURED_AT, stale: false, age_seconds: 60 },
  },
  cursor: {
    configured: true,
    error: null,
    plan_label: "Pro",
    primary_window: { used_percent: 40, reset_at: "2026-10-01T00:00:00.000Z" },
    secondary_window: { used_percent: 10, reset_at: "2026-10-01T00:00:00.000Z" },
    tertiary_window: null,
  },
  gemini: {
    configured: true,
    error: null,
    plan_label: "Pro",
    primary_window: { used_percent: 80, reset_at: null },
  },
  copilot: { configured: true, error: "Copilot usage request timed out." },
  kimi: { configured: false },
}

describe("tokentracker usage limits mapping", () => {
  test("names each agent's slots the way that agent means them", () => {
    const agents = machineAgentUsage(probe, 5_000)
    expect(agents.map((agent) => [agent.agent, agent.harness, agent.label, agent.plan])).toEqual([
      ["claude", "claude", "Claude Code", "Max"],
      ["cursor", "cursor", "Cursor", "Pro"],
      ["gemini", undefined, "Gemini", "Pro"],
      ["copilot", undefined, "Copilot", undefined],
    ])
    // 60.4 arrives as 60: every surface draws this as a bar and prints it as a
    // whole number, and the stored-account path rounds the same figure.
    expect(agents[0]?.windows).toEqual([
      { window: "session", usedPercent: 25, resetsAt: Date.parse("2026-09-13T15:00:00.000Z") },
      { window: "weekly", usedPercent: 60, resetsAt: null },
      { window: "Opus", usedPercent: 12, resetsAt: Date.parse("2026-09-20T00:00:00.000Z") },
    ])
    // `primary_window` is a session for Codex and the whole plan for Cursor, so
    // the same slot name must not reach the reader as the same word.
    expect(agents[1]?.windows.map((window) => window.window)).toEqual(["plan", "auto"])
  })

  test("an agent with no name for its slots keeps the probe's own", () => {
    expect(machineAgentUsage(probe, 5_000)[2]?.windows).toEqual([
      { window: "primary", usedPercent: 80, resetsAt: null },
    ])
  })

  test("an agent this machine does not have is left out, and one that failed says so", () => {
    const agents = machineAgentUsage(probe, 5_000)
    expect(agents.map((agent) => agent.agent)).not.toContain("kimi")
    expect(agents.find((agent) => agent.agent === "copilot")).toMatchObject({
      error: "Copilot usage request timed out.",
      windows: [],
    })
  })

  test("figures are dated when they were captured, not when they were asked for", () => {
    const agents = machineAgentUsage(probe, 5_000)
    expect(agents[0]?.at).toBe(Date.parse(CAPTURED_AT))
    expect(agents[2]?.at).toBe(Date.parse(FETCHED_AT))
    expect(machineAgentUsage({ claude: { configured: true, error: null } }, 5_000)[0]?.at).toBe(5_000)
  })

  test("a percentage the probe could not read is not a window at zero", () => {
    const agents = machineAgentUsage({
      fetched_at: FETCHED_AT,
      gemini: {
        configured: true,
        error: null,
        primary_window: { reset_at: "2026-10-01T00:00:00.000Z" },
        secondary_window: { used_percent: null },
        tertiary_window: { used_percent: 3 },
      },
    }, 5_000)
    expect(agents[0]?.windows).toEqual([{ window: "tertiary", usedPercent: 3, resetsAt: null }])
  })

  test("an answer that is not an object at all reports no agents", () => {
    expect(machineAgentUsage(undefined, 5_000)).toEqual([])
    expect(machineAgentUsage("down", 5_000)).toEqual([])
  })
})

/**
 * The module's clock is the real one, so each test starts an hour after the
 * last and finds the previous sweep expired.
 */
describe("the machine is swept once for every reader at a time", () => {
  let pending: Array<(answer: unknown) => void> = []
  let clock = Date.parse("2026-09-14T00:00:00.000Z")

  beforeEach(() => {
    pending = []
    clock += 3_600_000
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(clock)
    library.getUsageLimits.mockReset()
    library.resetUsageLimitsCache.mockReset()
    library.getUsageLimits.mockImplementation(() => new Promise((resolve) => { pending.push(resolve) }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // The probe loads the library before it sweeps, so a sweep is pending only
  // after that import has settled. Not `vi.waitFor`: under fake timers it
  // advances the faked clock on every poll, which shortens the window under test.
  const sweeping = async () => {
    while (pending.length === 0) await new Promise((resolve) => setImmediate(resolve))
  }

  const answer = async (plan: string) => {
    await sweeping()
    pending.shift()?.({ fetched_at: FETCHED_AT, claude: { configured: true, error: null, plan_label: plan } })
  }

  test("readers that arrive together, refreshing or not, take the one sweep already running", async () => {
    const both = Promise.all([readMachineAgentUsage({ fresh: false }), readMachineAgentUsage({ fresh: true })])
    await answer("Max")
    expect(library.getUsageLimits).toHaveBeenCalledTimes(1)

    expect((await both).map(([claude]) => claude?.plan)).toEqual(["Max", "Max"])
  })

  test("a sweep stands for a minute, and a refresh replaces the library's own answer inside it", async () => {
    const first = readMachineAgentUsage({ fresh: false })
    await answer("Max")
    expect((await first)[0]?.plan).toBe("Max")

    vi.setSystemTime(clock + 59_999)
    expect((await readMachineAgentUsage({ fresh: false }))[0]?.plan).toBe("Max")
    expect(library.getUsageLimits).toHaveBeenCalledTimes(1)
    expect(library.resetUsageLimitsCache).not.toHaveBeenCalled()

    const refreshed = readMachineAgentUsage({ fresh: true })
    await answer("Pro")
    expect(library.resetUsageLimitsCache).toHaveBeenCalledTimes(1)
    expect((await refreshed)[0]?.plan).toBe("Pro")

    vi.setSystemTime(clock + 59_999 + 60_000)
    const later = readMachineAgentUsage({ fresh: false })
    await answer("Free")
    expect(library.getUsageLimits).toHaveBeenCalledTimes(3)
    expect((await later)[0]?.plan).toBe("Free")
  })
})

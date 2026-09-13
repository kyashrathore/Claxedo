import { describe, expect, test } from "vitest"
import { machineAgentUsage } from "./token-tracker-usage-limits"

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
    expect(agents[0]?.windows).toEqual([
      { window: "session", usedPercent: 25, resetsAt: Date.parse("2026-09-13T15:00:00.000Z") },
      { window: "weekly", usedPercent: 60.4, resetsAt: null },
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

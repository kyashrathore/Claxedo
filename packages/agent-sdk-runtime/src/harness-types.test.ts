import { describe, expect, test } from "bun:test"

import { AGENT_HARNESS_DEFINITIONS } from "./harness-types"
import { AGENT_PROCESS_ATTRIBUTION_SCENARIOS } from "./process-observer"

describe("agent harness process catalog", () => {
  test("keeps one unique catalog key per supported harness and access", () => {
    expect(new Set(AGENT_HARNESS_DEFINITIONS.map((row) => row.key)).size).toBe(AGENT_HARNESS_DEFINITIONS.length)
    expect(
      new Set(AGENT_HARNESS_DEFINITIONS.map((row) => `${row.id}:${row.access}`)).size,
    ).toBe(AGENT_HARNESS_DEFINITIONS.length)
    expect(new Set(AGENT_HARNESS_DEFINITIONS.map((row) => row.id))).toEqual(
      new Set(["claude", "codex", "cursor", "opencode", "pi"]),
    )
  })
})

describe("process attribution catalog", () => {
  test("has an explicit root, probe, and MCP scenario for every harness definition", () => {
    expect(AGENT_PROCESS_ATTRIBUTION_SCENARIOS.map((scenario) => scenario.key).sort()).toEqual(
      AGENT_HARNESS_DEFINITIONS.map((definition) => definition.key).sort(),
    )
    for (const scenario of AGENT_PROCESS_ATTRIBUTION_SCENARIOS) {
      expect(scenario.root).toBeTruthy()
      expect(scenario.probe).toBeTruthy()
      expect(scenario.mcp).toBeTruthy()
    }
  })
})

describe("open ACP connection identity", () => {
  const { harnessKey, isAcpConnectionId, normalizeHarnessIdentity } = require("./harness-types") as typeof import("./harness-types")

  test("a validated open slug round-trips as an acp-qualified identity", () => {
    expect(normalizeHarnessIdentity({ id: "gemini", access: "acp" })).toEqual({ id: "gemini", access: "acp" })
    expect(normalizeHarnessIdentity("acp:gemini")).toEqual({ id: "gemini", access: "acp" })
    expect(harnessKey({ id: "gemini", access: "acp" })).toBe("acp:gemini")
  })

  test("native ids keep their built-in keys while ACP is always qualified", () => {
    expect(harnessKey({ id: "claude", access: "acp" })).toBe("acp:claude")
    expect(harnessKey({ id: "codex", access: "native" })).toBe("codex")
    expect(normalizeHarnessIdentity("acp:claude")).toEqual({ id: "claude", access: "acp" })
    expect(normalizeHarnessIdentity("codex-app-server")).toEqual({ id: "codex", access: "native" })
  })

  test("an unknown id never defaults to a native identity", () => {
    expect(normalizeHarnessIdentity("gemini")).toBeUndefined()
    expect(normalizeHarnessIdentity({ id: "gemini" })).toBeUndefined()
    expect(normalizeHarnessIdentity({ id: "gemini", access: "native" })).toBeUndefined()
  })

  test("custom slugs shadowing built-in names stay acp-qualified", () => {
    // An operator-defined `claude` ACP process is a legitimate custom
    // connection; it must resolve as acp-access identity, never dispatch
    // native.
    expect(normalizeHarnessIdentity({ id: "claude", access: "acp" })).toEqual({ id: "claude", access: "acp" })
    expect(harnessKey({ id: "claude", access: "acp" })).toBe("acp:claude")
  })

  test("blank, malformed, or overlong slugs fail validation", () => {
    expect(isAcpConnectionId("")).toBe(false)
    expect(isAcpConnectionId("Gemini")).toBe(false)
    expect(isAcpConnectionId("1gemini")).toBe(false)
    expect(isAcpConnectionId("gem ini")).toBe(false)
    expect(isAcpConnectionId("acp:gemini")).toBe(false)
    expect(isAcpConnectionId("g".repeat(65))).toBe(false)
    expect(isAcpConnectionId("gemini-2")).toBe(true)
    expect(normalizeHarnessIdentity({ id: "Gem ini", access: "acp" })).toBeUndefined()
    expect(normalizeHarnessIdentity("acp:")).toBeUndefined()
  })
})

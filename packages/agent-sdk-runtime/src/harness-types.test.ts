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

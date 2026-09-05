import { describe, expect, test } from "vitest"
import {
  AGENT_PLUGIN_HARNESS_REGISTRY,
  SUPPORTED_AGENT_PLUGIN_HARNESSES,
  allSupportedAgentPluginHarnesses,
  isAgentPluginHarnessId,
} from "./harness-registry"

describe("Agent Plugins harness registry", () => {
  test("has one descriptor for every supported harness and no implicit harnesses", () => {
    expect(AGENT_PLUGIN_HARNESS_REGISTRY.map((harness) => harness.id)).toEqual(SUPPORTED_AGENT_PLUGIN_HARNESSES)
    expect(new Set(AGENT_PLUGIN_HARNESS_REGISTRY.map((harness) => harness.id)).size).toBe(AGENT_PLUGIN_HARNESS_REGISTRY.length)
    expect(isAgentPluginHarnessId("pi")).toBe(false)
  })

  test("expands all to a copy of today's explicit registry", () => {
    const expanded = allSupportedAgentPluginHarnesses()
    expanded.pop()
    expect(SUPPORTED_AGENT_PLUGIN_HARNESSES).toEqual(["opencode", "claude", "codex", "cursor"])
  })
})

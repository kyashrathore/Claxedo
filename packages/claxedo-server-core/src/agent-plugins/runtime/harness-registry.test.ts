import { describe, expect, test } from "vitest"
import {
  AGENT_PLUGIN_HARNESS_REGISTRY,
  CLAUDE_AGENT_ACP,
  SUPPORTED_AGENT_PLUGIN_HARNESSES,
  agentPluginHarnessDescriptor,
  agentPluginHarnessRecord,
  agentPluginHarnessTargets,
  allSupportedAgentPluginHarnesses,
  isAgentPluginHarnessId,
} from "./harness-registry"

describe("Agent Plugins harness registry", () => {
  test("has one descriptor for every supported harness and no implicit harnesses", () => {
    expect(Object.keys(AGENT_PLUGIN_HARNESS_REGISTRY)).toEqual(SUPPORTED_AGENT_PLUGIN_HARNESSES)
    for (const id of SUPPORTED_AGENT_PLUGIN_HARNESSES) {
      expect(agentPluginHarnessDescriptor(id)).toEqual({ id, ...AGENT_PLUGIN_HARNESS_REGISTRY[id] })
      expect(isAgentPluginHarnessId(id)).toBe(true)
    }
    expect(isAgentPluginHarnessId("pi")).toBe(false)
  })

  test("builds exactly one value per registered harness", () => {
    const calls: string[] = []
    const record = agentPluginHarnessRecord((id) => {
      calls.push(id)
      return { id }
    })
    expect(calls).toEqual(SUPPORTED_AGENT_PLUGIN_HARNESSES)
    expect(Object.keys(record)).toEqual(SUPPORTED_AGENT_PLUGIN_HARNESSES)
    for (const id of SUPPORTED_AGENT_PLUGIN_HARNESSES) expect(record[id]).toEqual({ id })
  })

  test.each(["toString", "constructor", "__proto__", "", null, undefined, 1, {}])("rejects non-harness %s", (value) => {
    expect(isAgentPluginHarnessId(value)).toBe(false)
  })

  test("expands all to a copy of today's explicit registry", () => {
    const expanded = allSupportedAgentPluginHarnesses()
    expanded.pop()
    expect(SUPPORTED_AGENT_PLUGIN_HARNESSES).toEqual(["opencode", "claude", "codex", "cursor", "acp"])
  })

  test("custom ACP agents are a target that takes MCP servers, and whole plugins only over claude-agent-acp", () => {
    expect(isAgentPluginHarnessId("acp")).toBe(true)
    const acp = agentPluginHarnessDescriptor("acp")
    expect(acp.projection).toBe("session-request")
    expect(acp.delivery).toEqual({
      mcpServers: true,
      wholePlugins: { reach: "one-agent", agent: CLAUDE_AGENT_ACP },
      runningSession: { applies: "after-restart", restartsAgent: true },
      cloud: { httpServers: "plugin-mcp-gateway", localCommands: "image-declared-only", remoteAgent: "no-local-commands-no-local-paths" },
      local: { readsOwnGlobalConfiguration: true },
    })
    for (const native of ["opencode", "claude", "codex", "cursor"] as const) {
      expect(agentPluginHarnessDescriptor(native).delivery.wholePlugins).toEqual({ reach: "every-agent" })
    }
  })

  test("the catalog's target rows carry every caveat the install dialog states", () => {
    const targets = agentPluginHarnessTargets()
    expect(targets.map((target) => target.id)).toEqual(SUPPORTED_AGENT_PLUGIN_HARNESSES)
    for (const target of targets) {
      expect(target.label).toBeTruthy()
      expect(Object.keys(target.delivery).toSorted()).toEqual(["cloud", "local", "mcpServers", "runningSession", "wholePlugins"])
    }
  })
})

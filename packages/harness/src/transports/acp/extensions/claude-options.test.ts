import { expect, test } from "bun:test"
import type { InitializeResponse } from "@agentclientprotocol/sdk"
import { claudeOptionsMeta } from "./claude-options"

const input = { locality: "local" as const, projection: { generation: "g1", mcpServers: [], notApplied: [],
  pluginRoots: [{ pluginInstanceId: "p1", root: "/plugins/one", dataRoot: "/data/one" }] } }

function handshake(name: string, version: string): InitializeResponse {
  return { protocolVersion: 1, agentInfo: { name, version }, agentCapabilities: {}, authMethods: [] }
}

test("claude-agent-acp receives plugin roots through claudeCode options under the name it reports", () => {
  for (const version of ["0.63.0", "0.81.2", "0.10.9"]) {
    expect(claudeOptionsMeta(handshake("@agentclientprotocol/claude-agent-acp", version), input)).toEqual({ notApplied: [], meta: { claudeCode: {
      options: { plugins: [{ type: "local", path: "/plugins/one" }] },
    } } })
  }
})

test("an agent without the Agent SDK plugin option reports the roots as not applied instead of receiving paths", () => {
  const notApplied = [{ item: "p1", reason: "unsupported-by-harness" as const }]
  expect(claudeOptionsMeta(handshake("@agentclientprotocol/claude-agent-acp", "0.10.8"), input)).toEqual({ notApplied })
  expect(claudeOptionsMeta(handshake("@agentclientprotocol/claude-agent-acp", "0.81.2-beta.1"), input)).toEqual({ notApplied })
  expect(claudeOptionsMeta(handshake("other-acp", "0.63.0"), input)).toEqual({ notApplied })
  expect(claudeOptionsMeta(handshake("@agentclientprotocol/claude-agent-acp", "0.63.0"), { ...input, locality: "remote" })).toEqual({ notApplied: [] })
})

import { expect, test } from "bun:test"
import type { InitializeResponse } from "@agentclientprotocol/sdk"
import { claudeOptionsMeta } from "./claude-options"

const input = { locality: "local" as const, projection: { generation: "g1", mcpServers: [], notApplied: [],
  pluginRoots: [{ pluginInstanceId: "p1", root: "/plugins/one", dataRoot: "/data/one" }] } }

function handshake(name: string, version: string): InitializeResponse {
  return { protocolVersion: 1, agentInfo: { name, version }, agentCapabilities: {}, authMethods: [] }
}

test("verified Claude ACP receives plugin roots only through claudeCode options", () => {
  expect(claudeOptionsMeta(handshake("claude-agent-acp", "0.63.0"), input)).toEqual({ claudeCode: {
    options: { plugins: [{ type: "local", path: "/plugins/one" }] },
  } })
})

test("an unverified version cannot receive plugin paths", () => {
  expect(() => claudeOptionsMeta(handshake("claude-agent-acp", "0.64.0"), input)).toThrow("verified Claude plugin delivery")
  expect(() => claudeOptionsMeta(handshake("other-acp", "0.63.0"), input)).toThrow("verified Claude plugin delivery")
  expect(claudeOptionsMeta(handshake("claude-agent-acp", "0.63.0"), { ...input, locality: "remote" })).toBeUndefined()
})

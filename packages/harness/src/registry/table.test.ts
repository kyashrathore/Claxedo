import { expect, test } from "bun:test"
import { HARNESS_TABLE as CONTRACT_TABLE } from "@claxedo/agent-runtime-contract"
import { harnessRecord, harnessesForTransport } from "./table"

test("the table routes every built-in and custom provider", () => {
  expect(harnessRecord("claude")?.vendor).toBe(CONTRACT_TABLE.claude.vendor)
  expect(harnessRecord("claude")?.providerIds).toBe(CONTRACT_TABLE.claude.providerIds)
  expect(harnessRecord("claude")?.transport).toBe("claude-sdk")
  expect(harnessRecord("codex")?.transport).toBe("codex-app-server")
  expect(harnessRecord("cursor")?.transport).toBe("cursor-sdk")
  expect(harnessRecord("acp")?.transport).toBe("acp")
  expect(harnessRecord("opencode-server")).toBeUndefined()
  expect(harnessRecord("pi-rpc")?.transport).toBe("pi-rpc")
  expect(harnessRecord("unknown")).toBeUndefined()
  expect(harnessesForTransport("acp").map((row) => row.id)).toEqual(["acp"])
})

test("MCP capability matches the harnesses that accept MCP servers today", () => {
  expect(["claude", "codex", "cursor", "acp", "pi-rpc"].map((id) => [id, harnessRecord(id)?.mcp])).toEqual([
    ["claude", true],
    ["codex", true],
    ["cursor", true],
    ["acp", true],
    ["pi-rpc", false],
  ])
})

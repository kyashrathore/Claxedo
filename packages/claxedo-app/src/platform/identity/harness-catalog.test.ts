import { describe, expect, test } from "bun:test"
import {
  connectContextFor,
  engineConnectContext,
  harnessConnectContext,
  harnessForConnectProvider,
} from "./harness-catalog"

describe("harnessConnectContext", () => {
  test("names the harness and the vendor behind its login", () => {
    expect(harnessConnectContext("claude")).toEqual({ kind: "harness", harness: "Claude Code", vendor: "Anthropic" })
    expect(harnessConnectContext("codex")).toEqual({ kind: "harness", harness: "Codex", vendor: "OpenAI" })
  })

  test("an unknown harness falls back to what the caller already displays", () => {
    expect(harnessConnectContext("zed", "Zed")).toEqual({ kind: "harness", harness: "Zed", vendor: "Zed" })
  })
})

describe("connectContextFor", () => {
  test("a harness's own login provider is a harness context, whatever engine asked", () => {
    expect(connectContextFor({ providerId: "claude-sdk", engine: "pi", vendor: "Anthropic" }))
      .toEqual({ kind: "harness", harness: "Claude Code", vendor: "Anthropic" })
    expect(harnessForConnectProvider("cursor-sdk")).toBe("cursor")
  })

  test("any other provider is a vendor the engine runs, which is the other sentence", () => {
    expect(connectContextFor({ providerId: "anthropic", engine: "pi", vendor: "Anthropic" }))
      .toEqual({ kind: "engine", engine: "Pi", vendor: "Anthropic" })
    expect(engineConnectContext("opencode", "OpenAI")).toEqual({ kind: "engine", engine: "OpenCode", vendor: "OpenAI" })
  })
})

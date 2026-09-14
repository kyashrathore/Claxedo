import { describe, expect, test } from "bun:test"
import { NATIVE_HARNESS_IDS } from "@/platform/identity/harness-selection"
import {
  connectContextFor,
  engineConnectContext,
  harnessConnectContext,
  harnessDisplayLabel,
  harnessForConnectProvider,
  harnessIcon,
  harnessLabelForProviderId,
  harnessProviderIds,
} from "./harness-catalog"

describe("HARNESS_CATALOG", () => {
  test("an engine a reader picks is not a login anything is stored against", () => {
    expect(harnessProviderIds("pi")).toEqual([])
    expect(harnessProviderIds("opencode")).toEqual([])
  })

  test("every harness a reader can pick has a name and a mark of its own", () => {
    expect(NATIVE_HARNESS_IDS.map(harnessDisplayLabel))
      .toEqual(["Claude Code", "Codex", "Cursor", "Pi", "OpenCode"])
    expect(NATIVE_HARNESS_IDS.map(harnessIcon))
      .toEqual(["anthropic", "openai", "cursor", "pi", "opencode"])
  })

  test("a binding's registry id is read as the harness it stores a login for", () => {
    expect(harnessLabelForProviderId("claude-sdk")).toBe("Claude Code")
    expect(harnessLabelForProviderId("codex-app-server")).toBe("Codex")
    expect(harnessLabelForProviderId("cursor-acp")).toBe("Cursor")
    // A provider id no harness stores a login under names nothing here.
    expect(harnessLabelForProviderId("openrouter")).toBeUndefined()
  })
})

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

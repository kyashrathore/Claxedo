import { describe, expect, test } from "bun:test"
import {
  HARNESS_DISPLAY_NAMES,
  decodeSessionConfig,
  effectiveHarnessModel,
  extractModelsFromConfigOptions,
  failedHarness,
  hardFailedHarness,
  harnessProfile,
  optionsResponse,
  pickHarness,
  type HarnessType,
} from "./profile"

describe("harness profile", () => {
  test("infers harness from binary names", () => {
    expect(pickHarness(undefined, "/tmp/codex-acp")).toBe("codex-acp")
    expect(pickHarness(undefined, "/tmp/claude-agent-acp")).toBe("claude-acp")
    expect(pickHarness(undefined, "/tmp/agent")).toBe("cursor-acp")
    expect(pickHarness(undefined, "/tmp/cursor-agent")).toBe("cursor-acp")
    expect(pickHarness(undefined, "C:/agents/codex-acp.exe")).toBe("codex-acp")
    expect(pickHarness(undefined, "C:/agents/agent.exe")).toBe("cursor-acp")
  })

  test("keeps existing backslash binary matching behavior", () => {
    expect(pickHarness(undefined, "C:\\agents\\codex-acp.exe")).toBe("codex-acp")
    expect(pickHarness(undefined, "C:\\agents\\claude-agent-acp")).toBe("claude-acp")
    expect(pickHarness(undefined, "C:\\agents\\agent.exe")).toBeUndefined()
  })

  test("covers display names for every harness id", () => {
    const types: HarnessType[] = [
      "claude-acp",
      "codex-acp",
      "cursor-acp",
      "claude-sdk",
      "codex-app-server",
      "cursor-sdk",
      "opencode",
      "pi",
    ]

    for (const type of types) {
      expect(HARNESS_DISPLAY_NAMES[type]).toBeTruthy()
    }
    expect(HARNESS_DISPLAY_NAMES["agent"]).toBe("Cursor")
    expect(HARNESS_DISPLAY_NAMES["cursor-agent"]).toBe("Cursor")
  })

  test("resolves effective harness model", () => {
    expect(effectiveHarnessModel("codex-acp", "")).toBe("default")
    expect(effectiveHarnessModel("claude-acp", undefined)).toBe("default")
    expect(effectiveHarnessModel("codex-acp", "gpt-5.5")).toBe("gpt-5.5")
    expect(effectiveHarnessModel("opencode", "gpt-5.5")).toBe("")
    expect(effectiveHarnessModel("pi", undefined)).toBe("")
  })

  test("extracts model options with selectOptions precedence", () => {
    expect(extractModelsFromConfigOptions([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "opus",
        options: [{ value: "sonnet", name: "Sonnet" }],
        selectOptions: [{ id: "opus", name: "Opus" }],
      },
    ])).toEqual({
      currentModel: "opus",
      models: [{ id: "opus", name: "Opus" }],
    })
  })

  test("normalizes Cursor ACP default model spelling", () => {
    expect(extractModelsFromConfigOptions([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "default[]",
        options: [
          { value: "default[]", name: "Auto" },
          { value: "gpt-5.5[reasoning=medium]", name: "GPT-5.5" },
        ],
      },
    ])).toEqual({
      currentModel: "default",
      models: [
        { id: "default", name: "Auto" },
        { id: "gpt-5.5[reasoning=medium]", name: "GPT-5.5" },
      ],
    })
  })

  test("decodes legacy runner session config", () => {
    expect(decodeSessionConfig({
      runner: {
        type: "codex-acp",
        binary: "/tmp/codex-acp",
      },
      model: {
        modelID: "gpt-5.5",
      },
    })).toEqual({
      harness: {
        type: "codex-acp",
        binary: "/tmp/codex-acp",
      },
      model: {
        modelID: "gpt-5.5",
      },
    })
  })

  test("decodes harness id session config", () => {
    expect(decodeSessionConfig({
      harness: {
        id: "claude-acp",
      },
    }).harness?.type).toBe("claude-acp")

    expect(decodeSessionConfig({
      harness: {
        id: "unknown",
      },
    }).harness?.type).toBeUndefined()
  })

  test("decodes structured native and ACP harness identities", () => {
    expect(decodeSessionConfig({
      harness: {
        id: "codex",
        access: "native",
        ready: false,
      },
    }).harness).toMatchObject({
      type: "codex-app-server",
      ready: false,
    })

    expect(decodeSessionConfig({
      harness: {
        id: "cursor",
        access: "acp",
      },
    }).harness?.type).toBe("cursor-acp")
  })

  test("separates hard failures from not-ready status", () => {
    expect(failedHarness({ type: "codex-app-server", status: "configured", ready: false })).toBe(true)
    expect(hardFailedHarness({ type: "codex-app-server", status: "configured", ready: false })).toBe(false)
    expect(hardFailedHarness({ type: "codex-app-server", error: "auth required" })).toBe(true)
  })

  test("normalizes options response source and choices", () => {
    expect(optionsResponse({
      source: "live",
      stale: true,
      options: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "sonnet",
          options: [
            { value: "sonnet", name: "Sonnet", description: "Balanced" },
            { value: 1, name: "bad" },
          ],
        },
      ],
    })).toEqual({
      source: "harness",
      stale: true,
      options: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "sonnet",
          options: [{ value: "sonnet", name: "Sonnet", description: "Balanced" }],
        },
      ],
    })
  })

  test("profiles pi as a fixed virtual harness", () => {
    expect(harnessProfile("pi")).toEqual({
      displayName: "Pi",
      hasConfigOptions: false,
      fixedModel: { id: "virtual", name: "Virtual", provider: { id: "pi" } },
    })
  })

  test("stays pure and out of runtime/query/UI layers", async () => {
    const source = await Bun.file(new URL("./profile.ts", import.meta.url)).text()

    expect(source).not.toContain("solid-js")
    expect(source).not.toContain("@tanstack")
    expect(source).not.toContain("RuntimeGateway")
    expect(source).not.toContain("queryClient")
    expect(source).not.toContain("@opencode-ai/sdk")
    expect(source).not.toContain("localStorage")
  })
})

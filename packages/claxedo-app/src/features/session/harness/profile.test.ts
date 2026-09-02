import { describe, expect, test } from "bun:test"
import {
  HARNESS_DISPLAY_NAMES,
  decodeHarnessState,
  decodeSessionConfig,
  effectiveHarnessModel,
  extractModelsFromConfigOptions,
  extractThoughtLevelFromConfigOptions,
  failedHarness,
  hardFailedHarness,
  harnessDisplayLabel,
  harnessProfile,
  optionsResponse,
  pickHarness,
  type HarnessType,
} from "./profile"

describe("harness profile", () => {
  test("infers harness from native access + type pairs", () => {
    expect(pickHarness("claude", null, "native")).toBe("claude-sdk")
    expect(pickHarness("codex", null, "native")).toBe("codex-app-server")
    expect(pickHarness("cursor", null, "native")).toBe("cursor-sdk")
    expect(pickHarness("opencode", null, "native")).toBe("opencode")
    expect(pickHarness("pi", null, "native")).toBe("pi")
  })

  test("infers open acp:<slug> ids from acp access + type, and passes through an already-qualified id", () => {
    expect(pickHarness("claude", null, "acp")).toBe("acp:claude")
    expect(pickHarness("codex", null, "acp")).toBe("acp:codex")
    expect(pickHarness("acp:claude")).toBe("acp:claude")
    // access "acp" with a type that doesn't form a valid slug is rejected, not coerced.
    expect(pickHarness("Not Valid", null, "acp")).toBeUndefined()
  })

  test("ignores the binary argument entirely — selection flows through type + access only", () => {
    expect(pickHarness(undefined, "/tmp/codex-acp")).toBeUndefined()
    expect(pickHarness("opencode", "/tmp/some/unrelated/binary-path.exe", "native")).toBe("opencode")
    expect(pickHarness(undefined, "C:\\agents\\codex-acp.exe")).toBeUndefined()
    // An explicit identity is honored regardless of what the binary looks like.
    expect(pickHarness("claude-sdk", "/tmp/codex-acp")).toBe("claude-sdk")
    expect(pickHarness("acp:codex", "/tmp/claude-agent-acp")).toBe("acp:codex")
  })

  test("covers display names for every builtin harness id", () => {
    const types: HarnessType[] = [
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
    // Operator ACP connections have no table row; their label is derived.
    expect(harnessDisplayLabel("acp:claude")).toBe("Claude")
    expect(harnessDisplayLabel("acp:my-agent")).toBe("My Agent")
  })

  test("resolves effective harness model", () => {
    expect(effectiveHarnessModel("acp:codex", "")).toBe("default")
    expect(effectiveHarnessModel("acp:claude", undefined)).toBe("default")
    expect(effectiveHarnessModel("acp:codex", "gpt-5.5")).toBe("gpt-5.5")
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
        type: "codex-app-server",
        binary: "/tmp/codex",
      },
      model: {
        modelID: "gpt-5.5",
      },
    })).toEqual({
      harness: {
        type: "codex-app-server",
        binary: "/tmp/codex",
      },
      model: {
        modelID: "gpt-5.5",
      },
    })
  })

  test("decodes harness id session config", () => {
    expect(decodeSessionConfig({
      harness: {
        id: "claude-sdk",
      },
    }).harness?.type).toBe("claude-sdk")

    expect(decodeSessionConfig({
      harness: {
        id: "acp:claude",
      },
    }).harness?.type).toBe("acp:claude")

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
    }).harness?.type).toBe("acp:cursor")
  })

  test("decodes harness health forwarded from the health route (T4)", () => {
    expect(decodeHarnessState({
      type: "codex-app-server",
      ready: true,
      harnessHealth: { status: "degraded", reason: "harness_process_lost" },
    })?.harnessHealth).toEqual({ status: "degraded", reason: "harness_process_lost" })
    // Unknown / malformed health status is dropped rather than carried through.
    expect(decodeHarnessState({
      type: "codex-app-server",
      harnessHealth: { status: "bogus" },
    })?.harnessHealth).toBeUndefined()
    expect(decodeHarnessState({ type: "codex-app-server" })?.harnessHealth).toBeUndefined()
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

  test("profiles Pi as a catalog-backed harness", () => {
    expect(harnessProfile("pi")).toEqual({
      displayName: "Pi",
      hasConfigOptions: false,
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

/**
 * Payload shapes here are transcribed from the agents themselves, not invented:
 *  - codex-acp 1.1.7 `createReasoningEffortConfigOption` emits
 *    `{ id, name: "Reasoning effort", category: "thought_level", type: "select",
 *       currentValue, options: [{ value, name, description }] }`
 *  - claude-agent-acp 0.63.0 emits the same shape with `name: "Effort"` and
 *    `options` starting with a literal `{ value: "default", name: "Default" }`.
 * `thought_level` is a first-class category in the ACP schema
 * (`SessionConfigOptionCategory = "mode" | "model" | "model_config" | "thought_level" | string`).
 */
describe("extractThoughtLevelFromConfigOptions", () => {
  test("reads codex-acp's reasoning-effort option", () => {
    expect(extractThoughtLevelFromConfigOptions([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "gpt-5",
        selectOptions: [{ id: "gpt-5", name: "GPT-5" }],
      },
      {
        id: "reasoning_effort",
        name: "Reasoning effort",
        category: "thought_level",
        type: "select",
        currentValue: "medium",
        options: [
          { value: "low", name: "Low", description: "Fastest" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
    ])).toEqual({
      current: "medium",
      levels: [
        { id: "low", name: "Low", description: "Fastest" },
        { id: "medium", name: "Medium" },
        { id: "high", name: "High" },
      ],
    })
  })

  test("reads claude-agent-acp's effort option, default row included", () => {
    expect(extractThoughtLevelFromConfigOptions([
      {
        id: "effort",
        name: "Effort",
        category: "thought_level",
        type: "select",
        currentValue: "default",
        options: [
          { value: "default", name: "Default" },
          { value: "high", name: "High" },
        ],
      },
    ])).toEqual({
      current: "default",
      levels: [{ id: "default", name: "Default" }, { id: "high", name: "High" }],
    })
  })

  // The native SDK path supplies `selectOptions` (id/name) rather than ACP's
  // `options` (value/name), exactly as the model option does.
  test("reads a selectOptions-shaped effort option", () => {
    expect(extractThoughtLevelFromConfigOptions([
      {
        id: "effort",
        name: "Effort",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        selectOptions: [{ id: "high", name: "High" }, { id: "max", name: "Max" }],
      },
    ])).toEqual({
      current: "high",
      levels: [{ id: "high", name: "High" }, { id: "max", name: "Max" }],
    })
  })

  test("is null when the harness offers no thought-level option", () => {
    expect(extractThoughtLevelFromConfigOptions([
      { id: "model", name: "Model", category: "model", type: "select", currentValue: "opus", selectOptions: [{ id: "opus", name: "Opus" }] },
    ])).toBeNull()
  })

  // A single choice is not a choice — offering it spends a whole disclosure
  // section on something the user cannot change.
  test("is null when only one level is offered", () => {
    expect(extractThoughtLevelFromConfigOptions([
      { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "high", name: "High" }] },
    ])).toBeNull()
  })
})

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
} from "./profile"

describe("harness profile", () => {
  test("decodes explicit native and opaque connection identities", () => {
    for (const harnessId of ["claude", "codex", "cursor", "pi"] as const) {
      const selection = { kind: "native", harnessId } as const
      expect(pickHarness({ id: harnessId, access: "native" })).toEqual(selection)
      expect(pickHarness(selection)).toEqual(selection)
    }
    for (const connectionId of ["team-codex", "openclaw", "opencode", "acp:literal-id"]) {
      const selection = { kind: "connection", connectionId } as const
      expect(pickHarness({ id: connectionId, access: "connection" })).toEqual(selection)
      expect(pickHarness(selection)).toEqual(selection)
    }
  })

  test("rejects legacy identities and does not infer a harness from binaries", () => {
    for (const value of [
      "claude",
      "claude-sdk",
      "opencode",
      "acp:codex",
      { id: "opencode", access: "native" },
      { id: "claude", access: "acp" },
      { id: "codex" },
      { binary: "/tmp/codex-acp" },
      { kind: "connection", connectionId: "" },
      { kind: "native", harnessId: "unknown" },
    ])
      expect(pickHarness(value)).toBeUndefined()
    expect(pickHarness({ id: "my-agent", access: "connection", binary: "/tmp/codex" })).toEqual({
      kind: "connection",
      connectionId: "my-agent",
    })
  })

  test("covers exactly the native display names without vendor-specific connection aliases", () => {
    expect(HARNESS_DISPLAY_NAMES).toEqual({ claude: "Claude", codex: "Codex", cursor: "Cursor", pi: "Pi" })
    expect(harnessDisplayLabel("my-agent")).toBe("My Agent")
    expect(harnessDisplayLabel("acp:literal-id")).toBe("Acp:literal Id")
  })

  test("resolves selected models without treating external OpenCode specially", () => {
    const external = { kind: "connection", connectionId: "opencode" } as const
    expect(effectiveHarnessModel(external, "")).toBe("default")
    expect(effectiveHarnessModel(external, "gpt-5.5")).toBe("gpt-5.5")
    expect(effectiveHarnessModel({ kind: "native", harnessId: "pi" }, undefined)).toBe("")
  })

  test("extracts model options with selectOptions precedence", () => {
    expect(
      extractModelsFromConfigOptions([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "opus",
          options: [{ value: "sonnet", name: "Sonnet" }],
          selectOptions: [{ id: "opus", name: "Opus" }],
        },
      ]),
    ).toEqual({
      currentModel: "opus",
      models: [{ id: "opus", name: "Opus" }],
    })
  })

  test("preserves opaque model IDs, including bracketed default values", () => {
    expect(
      extractModelsFromConfigOptions([
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
      ]),
    ).toEqual({
      currentModel: "default[]",
      models: [
        { id: "default[]", name: "Auto" },
        { id: "gpt-5.5[reasoning=medium]", name: "GPT-5.5" },
      ],
    })
  })

  test("does not decode removed runner session config", () => {
    expect(
      decodeSessionConfig({
        runner: {
          type: "codex-app-server",
          binary: "/tmp/codex",
        },
        model: {
          modelID: "gpt-5.5",
        },
      }),
    ).toEqual({
      harness: {},
      model: {
        modelID: "gpt-5.5",
      },
    })
  })

  test("requires access when decoding wire harness identities", () => {
    expect(
      decodeSessionConfig({
        harness: {
          id: "claude-sdk",
        },
      }).harness?.type,
    ).toBeUndefined()

    expect(
      decodeSessionConfig({
        harness: {
          id: "acp:claude",
        },
      }).harness?.type,
    ).toBeUndefined()

    expect(
      decodeSessionConfig({
        harness: {
          id: "unknown",
        },
      }).harness?.type,
    ).toBeUndefined()
  })

  test("decodes structured native and connection harness identities", () => {
    expect(
      decodeSessionConfig({
        harness: {
          id: "codex",
          access: "native",
        },
      }).harness,
    ).toEqual({
      type: { kind: "native", harnessId: "codex" },
      activeType: { kind: "native", harnessId: "codex" },
    })

    expect(
      decodeSessionConfig({
        harness: {
          id: "remote-cursor",
          access: "connection",
        },
      }).harness?.type,
    ).toEqual({ kind: "connection", connectionId: "remote-cursor" })
  })

  test("decodes harness health forwarded from the health route (T4)", () => {
    expect(
      decodeHarnessState({
        harness: { kind: "native", harnessId: "codex" },
        ready: true,
        harnessHealth: { status: "degraded", reason: "harness_process_lost" },
      })?.harnessHealth,
    ).toEqual({ status: "degraded", reason: "harness_process_lost" })
    // Unknown / malformed health status is dropped rather than carried through.
    expect(
      decodeHarnessState({
        harness: { kind: "native", harnessId: "codex" },
        harnessHealth: { status: "bogus" },
      })?.harnessHealth,
    ).toBeUndefined()
    expect(decodeHarnessState({ harness: { kind: "native", harnessId: "codex" } })?.harnessHealth).toBeUndefined()
  })

  test("separates hard failures from not-ready status", () => {
    const codex = { kind: "native", harnessId: "codex" } as const
    expect(failedHarness({ type: codex, status: "configured", ready: false })).toBe(true)
    expect(hardFailedHarness({ type: codex, status: "configured", ready: false })).toBe(false)
    expect(hardFailedHarness({ type: codex, error: "auth required" })).toBe(true)
  })

  test("normalizes options response source and choices", () => {
    expect(
      optionsResponse({
        source: "harness",
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
      }),
    ).toEqual({
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

  test("does not trust removed or unknown model-option source aliases", () => {
    for (const source of ["live", "unknown"]) {
      expect(optionsResponse({ options: [], source, stale: true })).toEqual({
        options: [],
        source: "empty",
        stale: true,
      })
    }
  })

  // `/api/wr/harness-config-options` answers the adapter contract's
  // `AgentConfigOptions` verbatim: the options the harness published plus the
  // model it resolved for itself, and NO freshness bookkeeping of its own.
  test("reads the workspace runtime's bare config-options answer as a live harness answer", () => {
    expect(
      optionsResponse({
        options: [
          {
            id: "thought_level",
            name: "Thought level",
            category: "thought_level",
            type: "select",
            currentValue: "adaptive",
            options: [{ value: "adaptive", name: "Adaptive" }],
          },
        ],
        resolvedModel: { id: "claude-opus-4-6", name: "Opus 4.6" },
      }),
    ).toEqual({
      source: "harness",
      stale: false,
      resolvedModel: { id: "claude-opus-4-6", name: "Opus 4.6" },
      options: [
        {
          id: "thought_level",
          name: "Thought level",
          category: "thought_level",
          type: "select",
          currentValue: "adaptive",
          options: [{ value: "adaptive", name: "Adaptive" }],
        },
      ],
    })
  })

  // A harness that named no current model yields no field — the client is told
  // nothing was reported rather than handed a guess.
  test("carries no resolved model when the runtime reported none", () => {
    expect(optionsResponse({ options: [] })).toEqual({
      source: "harness",
      stale: false,
      options: [],
    })
  })

  // The daemon route wraps the same payload in its own freshness bookkeeping;
  // its `resolvedModel` rides through unchanged.
  test("keeps the daemon's own source and staleness while carrying its resolved model", () => {
    expect(
      optionsResponse({
        source: "catalog",
        stale: true,
        options: [],
        resolvedModel: { id: "gpt-5.5-codex", name: "GPT-5.5 Codex" },
      }),
    ).toEqual({
      source: "catalog",
      stale: true,
      resolvedModel: { id: "gpt-5.5-codex", name: "GPT-5.5 Codex" },
      options: [],
    })
  })

  test("drops a resolved model the producer did not label", () => {
    expect(optionsResponse({ source: "harness", stale: false, options: [], resolvedModel: { id: "opus" } })).toEqual({
      source: "harness",
      stale: false,
      options: [],
    })
  })

  test("profiles Pi as a catalog-backed harness", () => {
    expect(harnessProfile({ kind: "native", harnessId: "pi" })).toEqual({
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
    expect(
      extractThoughtLevelFromConfigOptions([
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
      ]),
    ).toEqual({
      current: "medium",
      levels: [
        { id: "low", name: "Low", description: "Fastest" },
        { id: "medium", name: "Medium" },
        { id: "high", name: "High" },
      ],
    })
  })

  test("reads claude-agent-acp's effort option, default row included", () => {
    expect(
      extractThoughtLevelFromConfigOptions([
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
      ]),
    ).toEqual({
      current: "default",
      levels: [
        { id: "default", name: "Default" },
        { id: "high", name: "High" },
      ],
    })
  })

  // The native SDK path supplies `selectOptions` (id/name) rather than ACP's
  // `options` (value/name), exactly as the model option does.
  test("reads a selectOptions-shaped effort option", () => {
    expect(
      extractThoughtLevelFromConfigOptions([
        {
          id: "effort",
          name: "Effort",
          category: "thought_level",
          type: "select",
          currentValue: "high",
          selectOptions: [
            { id: "high", name: "High" },
            { id: "max", name: "Max" },
          ],
        },
      ]),
    ).toEqual({
      current: "high",
      levels: [
        { id: "high", name: "High" },
        { id: "max", name: "Max" },
      ],
    })
  })

  test("is null when the harness offers no thought-level option", () => {
    expect(
      extractThoughtLevelFromConfigOptions([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "opus",
          selectOptions: [{ id: "opus", name: "Opus" }],
        },
      ]),
    ).toBeNull()
  })

  // A single choice is not a choice — offering it spends a whole disclosure
  // section on something the user cannot change.
  test("is null when only one level is offered", () => {
    expect(
      extractThoughtLevelFromConfigOptions([
        {
          id: "effort",
          name: "Effort",
          category: "thought_level",
          type: "select",
          currentValue: "high",
          options: [{ value: "high", name: "High" }],
        },
      ]),
    ).toBeNull()
  })
})

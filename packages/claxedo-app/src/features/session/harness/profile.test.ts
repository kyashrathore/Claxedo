import { describe, expect, test } from "bun:test"
import {
  activeHarness,
  desiredHarness,
  decodeHarnessState,
  decodeSessionConfig,
  extractModelsFromConfigOptions,
  extractThoughtLevelFromConfigOptions,
  failedHarness,
  hardFailedHarness,
  harnessDisplayLabel,
  harnessProfile,
  optionsResponse,
  pickHarness,
} from "./profile"
import { NATIVE_HARNESS_IDS } from "@/platform/identity/harness-selection"

describe("harness profile", () => {
  test("decodes only canonical connection observation states", () => {
    for (const state of ["configured", "connecting", "ready", "auth-required", "disconnected", "failed"]) {
      expect(decodeHarnessState({ connectionState: { connectionId: "acp", state, configStamp: "private", processes: [] } })?.connectionState).toEqual({ connectionId: "acp", state })
    }
    expect(decodeHarnessState({ connectionState: { connectionId: "acp", state: "authenticated" } })?.connectionState).toBeUndefined()
    expect(decodeHarnessState({ connectionState: { state: "ready" } })?.connectionState).toBeUndefined()
  })
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
      { id: "legacy-engine", access: "native" },
      { id: "claude", access: "acp" },
      { id: "codex" },
      { binary: "/tmp/codex-acp" },
      { kind: "connection", connectionId: "" },
      { kind: "native", harnessId: "unknown" },
    ])
      expect(pickHarness(value)).toBeUndefined()
    // The embedded-SDK OpenCode harness is a closed native id again.
    expect(pickHarness({ id: "opencode", access: "native" })).toEqual({ kind: "native", harnessId: "opencode" })
    expect(pickHarness({ id: "my-agent", access: "connection", binary: "/tmp/codex" })).toEqual({
      kind: "connection",
      connectionId: "my-agent",
    })
  })

  test("names every native harness as the product does, and title-cases an operator's own key", () => {
    expect(NATIVE_HARNESS_IDS.map(harnessDisplayLabel))
      .toEqual(["Claude Code", "Codex", "Cursor", "Pi", "OpenCode"])
    expect(harnessDisplayLabel("my-agent")).toBe("My Agent")
    expect(harnessDisplayLabel("acp:literal-id")).toBe("Acp:literal Id")
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

  test("preserves harness-reported provider connection on model options", () => {
    expect(
      extractModelsFromConfigOptions(
        optionsResponse({
          options: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "anthropic/sonnet",
              selectOptions: [
                { id: "anthropic/sonnet", name: "Sonnet", connected: true },
                { id: "amazon-bedrock/nova", name: "Nova", connected: false },
              ],
            },
          ],
        }).options,
      ),
    ).toEqual({
      currentModel: "anthropic/sonnet",
      models: [
        { id: "anthropic/sonnet", name: "Sonnet", connected: true },
        { id: "amazon-bedrock/nova", name: "Nova", connected: false },
      ],
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

  test("profiles Pi as a native harness with process config options", () => {
    expect(harnessProfile({ kind: "native", harnessId: "pi" })).toEqual({
      displayName: "Pi",
      hasConfigOptions: true,
    })
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

  describe("desiredHarness vs activeHarness during switch", () => {
    test("separates desired from active while a switch is in flight", () => {
      const data = {
        type: { kind: "connection", connectionId: "acp:codex" },
        binary: "/tmp/codex-acp",
        activeType: { kind: "connection", connectionId: "acp:claude" },
        activeBinary: "/tmp/claude-agent-acp",
      } as const

      expect(desiredHarness(data)).toEqual({ kind: "connection", connectionId: "acp:codex" })
      expect(activeHarness(data)).toEqual({ kind: "connection", connectionId: "acp:claude" })
    })

    test("desired and active match when no switch is happening", () => {
      const data = {
        type: { kind: "connection", connectionId: "acp:claude" },
        binary: "/tmp/claude-agent-acp",
        activeType: { kind: "connection", connectionId: "acp:claude" },
        activeBinary: "/tmp/claude-agent-acp",
      } as const

      expect(desiredHarness(data)).toEqual({ kind: "connection", connectionId: "acp:claude" })
      expect(activeHarness(data)).toEqual({ kind: "connection", connectionId: "acp:claude" })
    })

    test("activeHarness falls back to type when activeType is missing", () => {
      const data = {
        type: { kind: "connection", connectionId: "acp:codex" },
        binary: "/tmp/codex-acp",
      } as const

      expect(activeHarness(data)).toEqual({ kind: "connection", connectionId: "acp:codex" })
    })
  })
  describe("failedHarness", () => {
    test("treats error status as terminal", () => {
      expect(failedHarness({ type: { kind: "connection", connectionId: "acp:codex" }, status: "error" })).toBe(true)
    })

    test("treats error message as terminal", () => {
      expect(
        failedHarness({ type: { kind: "connection", connectionId: "acp:claude" }, error: "binary not found" }),
      ).toBe(true)
    })

    test("ready state is not failed", () => {
      expect(failedHarness({ type: { kind: "connection", connectionId: "acp:claude" }, status: "ready" })).toBe(false)
    })

    test("no status and no error is not failed", () => {
      expect(failedHarness({ type: { kind: "connection", connectionId: "external-opencode" } })).toBe(false)
    })
  })
  describe("extractModelsFromConfigOptions", () => {
    test("returns models from a model select option", () => {
      const result = extractModelsFromConfigOptions([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "opus",
          options: [
            { value: "sonnet", name: "Sonnet" },
            { value: "opus", name: "Opus" },
          ],
        },
      ])

      expect(result).toEqual({
        currentModel: "opus",
        models: [
          { id: "sonnet", name: "Sonnet" },
          { id: "opus", name: "Opus" },
        ],
      })
    })

    test("returns null when no model option exists", () => {
      const result = extractModelsFromConfigOptions([
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "default",
          options: [{ value: "default", name: "Default" }],
        },
      ])

      expect(result).toBeNull()
    })

    test("returns null when model option has no choices", () => {
      const result = extractModelsFromConfigOptions([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "",
          options: [],
        },
      ])

      expect(result).toBeNull()
    })
  })

import { describe, expect, test } from "bun:test"
import {
  cycleModelVariant,
  firstConnectedModel,
  firstConnectedModelInfo,
  firstValidSelectionModel,
  getConfiguredAgentVariant,
  promptModelFallbackState,
  promptModelState,
  resolveModelVariant,
  selectRuntimeModel,
  shouldUsePromptFallbackModel,
} from "./model-strategy"

describe("model-strategy", () => {
  test("uses the provider default when it exists", () => {
    expect(
      firstConnectedModel({
        connected: [{ id: "openai", models: { "gpt-5.3-chat-latest": { id: "gpt-5.3-chat-latest" } } }],
        defaults: { openai: "gpt-5.3-chat-latest" },
      }),
    ).toEqual({ providerID: "openai", modelID: "gpt-5.3-chat-latest" })
  })

  test("skips the stale OpenCode default when live free models are available", () => {
    expect(
      firstConnectedModel({
        connected: [
          {
            id: "opencode",
            models: {
              "mimo-v2.5-free": { id: "mimo-v2.5-free" },
              "big-pickle": { id: "big-pickle" },
            },
          },
        ],
        defaults: { opencode: "big-pickle" },
      }),
    ).toEqual({ providerID: "opencode", modelID: "mimo-v2.5-free" })
  })

  test("falls back to the first connected model", () => {
    expect(
      firstConnectedModel({
        connected: [{ id: "opencode", models: { "free-model": { id: "free-model" } } }],
        defaults: { opencode: "missing" },
      }),
    ).toEqual({ providerID: "opencode", modelID: "free-model" })
  })

  test("skips providers with no connected models", () => {
    expect(
      firstConnectedModel({
        connected: [
          { id: "empty", models: {} },
          { id: "opencode", models: { "next-model": { id: "next-model" } } },
        ],
        defaults: {},
      }),
    ).toEqual({ providerID: "opencode", modelID: "next-model" })
  })

  test("prefers a credentialed provider over the zero-key OpenCode gateway", () => {
    expect(
      firstConnectedModel({
        connected: [
          { id: "opencode", models: { "deepseek-v4-flash-free": { id: "deepseek-v4-flash-free" } } },
          { id: "google", models: { "gemini-3-pro-image-preview": { id: "gemini-3-pro-image-preview" } } },
          { id: "openai", models: { "gpt-5.3-chat-latest": { id: "gpt-5.3-chat-latest" } } },
        ],
        defaults: {},
      }),
    ).toEqual({ providerID: "openai", modelID: "gpt-5.3-chat-latest" })
  })

  // The reported defect: a setup-token Claude connection left the composer on a
  // free gateway model whose first turn failed upstream.
  test("a lone connected Anthropic credential wins the default over the gateway", () => {
    expect(
      firstConnectedModel({
        connected: [
          { id: "opencode", models: { "north-mini-code-free": { id: "north-mini-code-free" } } },
          { id: "anthropic", models: { "claude-sonnet-4-5": { id: "claude-sonnet-4-5" } } },
        ],
        defaults: {},
      }),
    ).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4-5" })
  })

  test("the gateway still supplies the default when it is the only connected provider", () => {
    expect(
      firstConnectedModel({
        connected: [{ id: "opencode", models: { "north-mini-code-free": { id: "north-mini-code-free" } } }],
        defaults: {},
      }),
    ).toEqual({ providerID: "opencode", modelID: "north-mini-code-free" })
  })

  test("an unranked credentialed provider still outranks the gateway", () => {
    expect(
      firstConnectedModel({
        connected: [
          { id: "opencode", models: { "north-mini-code-free": { id: "north-mini-code-free" } } },
          { id: "openrouter", models: { "some-paid-model": { id: "some-paid-model" } } },
        ],
        defaults: {},
      }),
    ).toEqual({ providerID: "openrouter", modelID: "some-paid-model" })
  })

  test("returns undefined when no connected model exists", () => {
    expect(firstConnectedModel({ connected: [{ id: "opencode", models: {} }], defaults: {} })).toBeUndefined()
  })

  test("returns renderable model info with provider attached", () => {
    expect(
      firstConnectedModelInfo({
        connected: [{ id: "opencode", models: { "kimi-k2.5-free": { id: "kimi-k2.5-free", name: "Kimi K2.5 Free" } } }],
        defaults: { opencode: "kimi-k2.5-free" },
      }),
    ).toMatchObject({ id: "kimi-k2.5-free", name: "Kimi K2.5 Free", provider: { id: "opencode" } })
  })

  test("runtime submit model selection keeps an explicit selected model", () => {
    expect(
      selectRuntimeModel(
        {
          all: [{ id: "opencode", models: { "big-pickle": { name: "Big Pickle" } } }],
          connected: ["opencode"],
          default: { opencode: "big-pickle" },
        },
        { id: "sonnet", provider: { id: "anthropic" } },
      ),
    ).toEqual({
      id: "sonnet",
      provider: { id: "anthropic" },
    })
  })

  test("runtime submit model selection rejects an explicit signed-workspace placeholder", () => {
    expect(
      selectRuntimeModel(
        {
          all: [{ id: "opencode", models: { "big-pickle": { name: "Big Pickle" } } }],
          connected: ["opencode"],
          default: { opencode: "big-pickle" },
        },
        { id: "big-pickle", provider: { id: "opencode" } },
      ),
    ).toBeUndefined()
  })

  test("runtime submit model selection parses connected provider responses", () => {
    expect(
      selectRuntimeModel(
        {
          all: [
            { id: "openai", models: { "gpt-5.3-chat-latest": { name: "GPT 5.3 Chat" } } },
            { id: "google", models: { "gemini-3-pro-image-preview": { name: "Gemini 3 Pro Image" } } },
            { id: "opencode", models: { "deepseek-v4-flash-free": { name: "DeepSeek V4 Flash" } } },
          ],
          connected: ["google", "opencode", "openai"],
          default: {
            google: "gemini-3-pro-image-preview",
            opencode: "deepseek-v4-flash-free",
            openai: "gpt-5.3-chat-latest",
          },
        },
        undefined,
      ),
    ).toMatchObject({
      id: "gpt-5.3-chat-latest",
      name: "GPT 5.3 Chat",
      provider: { id: "openai" },
    })
  })

  test("runtime submit model selection uses model map keys when ids are omitted", () => {
    expect(
      selectRuntimeModel(
        {
          all: [{ id: "opencode", models: { "kimi-k2.5-free": { name: "Kimi K2.5 Free" } } }],
          connected: ["opencode"],
          default: { opencode: "kimi-k2.5-free" },
        },
        undefined,
      ),
    ).toMatchObject({
      id: "kimi-k2.5-free",
      name: "Kimi K2.5 Free",
      provider: { id: "opencode" },
    })
  })

  test("runtime submit model selection ignores malformed provider payloads", () => {
    expect(
      selectRuntimeModel(
        {
          all: [
            { id: 123, models: { broken: { name: "Broken" } } },
            { id: "empty", models: null },
          ],
          connected: ["empty"],
          default: { empty: "missing" },
        },
        undefined,
      ),
    ).toBeUndefined()
  })

  test("picks the first valid saved selection model for draft fallback", () => {
    expect(
      firstValidSelectionModel({
        selections: [
          undefined,
          { model: { providerID: "opencode", modelID: "north-mini-code-free" } },
          { model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" } },
        ],
        valid: (model) => model.modelID === "deepseek-v4-flash-free",
      }),
    ).toEqual({ providerID: "opencode", modelID: "deepseek-v4-flash-free" })
  })

  test("allows provider-mode submit when model is resolved", () => {
    expect(
      promptModelState({
        harnessMode: false,
        providerLoading: false,
        model: { name: "Nano Banana Pro" },
        agent: { name: "build" },
      }),
    ).toEqual({
      blocked: false,
      disabled: false,
      label: "Nano Banana Pro",
    })
  })

  test("blocks provider-mode submit while provider models are loading", () => {
    expect(
      promptModelState({
        harnessMode: false,
        providerLoading: true,
        agent: { name: "build" },
      }),
    ).toEqual({
      blocked: true,
      disabled: true,
      label: "Loading models",
    })
  })

  test("blocks provider-mode submit when no model can be resolved", () => {
    expect(
      promptModelState({
        harnessMode: false,
        providerLoading: false,
        agent: { name: "build" },
      }),
    ).toEqual({
      blocked: true,
      disabled: true,
      label: "Select model",
    })
  })

  test("treats the signed-workspace placeholder as a missing model", () => {
    expect(promptModelState({
      harnessMode: false,
      providerLoading: false,
      model: { id: "big-pickle", name: "Big Pickle", provider: { id: "opencode" } },
      agent: { name: "build" },
    })).toEqual({
      blocked: true,
      disabled: true,
      label: "Select model",
    })
  })

  test("uses the model label when live agent options are unavailable", () => {
    expect(
      promptModelState({
        harnessMode: false,
        providerLoading: false,
        model: { name: "Nano Banana Pro" },
      }),
    ).toEqual({
      blocked: false,
      disabled: false,
      label: "Nano Banana Pro",
    })
  })

  test("allows provider-mode submit with an explicit agent override", () => {
    expect(
      promptModelState({
        harnessMode: false,
        providerLoading: false,
        model: { name: "Nano Banana Pro" },
        agentOverride: "doc",
      }),
    ).toEqual({
      blocked: false,
      disabled: false,
      label: "Nano Banana Pro",
    })
  })

  test("leaves runner mode to the runner readiness state machine", () => {
    expect(
      promptModelState({
        harnessMode: true,
        providerLoading: true,
      }),
    ).toEqual({
      blocked: false,
      disabled: false,
      label: undefined,
    })
  })

  test("prompt model fallback only applies to an uninitialized or invalid provider-mode scope", () => {
    expect(
      promptModelFallbackState({
        harnessMode: false,
        hasCurrentModel: false,
        hasSelection: false,
        providerLoading: false,
      }),
    ).toEqual({ type: "uninitialized", fallback: true })
    expect(
      shouldUsePromptFallbackModel({
        harnessMode: false,
        hasCurrentModel: false,
        hasSelection: false,
        providerLoading: false,
      }),
    ).toBe(true)

    expect(
      promptModelFallbackState({
        harnessMode: false,
        hasCurrentModel: false,
        hasSelection: true,
        providerLoading: false,
      }),
    ).toEqual({ type: "invalid-selected", fallback: true })

    expect(
      promptModelFallbackState({
        harnessMode: false,
        hasCurrentModel: false,
        hasSelection: false,
        providerLoading: true,
      }),
    ).toEqual({ type: "hydrating", fallback: false })

    expect(
      promptModelFallbackState({
        harnessMode: false,
        hasCurrentModel: false,
        hasSelection: false,
        providerLoading: false,
        restoreLoading: true,
      }),
    ).toEqual({ type: "hydrating", fallback: false })

    expect(
      promptModelFallbackState({
        harnessMode: false,
        existingSession: true,
        hasCurrentModel: false,
        hasSelection: false,
        providerLoading: false,
        restoreLoading: false,
      }),
    ).toEqual({ type: "needs-selection", fallback: false })

    expect(
      promptModelFallbackState({
        harnessMode: true,
        hasCurrentModel: false,
        hasSelection: false,
        providerLoading: false,
      }),
    ).toEqual({ type: "harness-owned", fallback: false })

    expect(
      promptModelFallbackState({
        harnessMode: false,
        hasCurrentModel: true,
        hasSelection: false,
        providerLoading: false,
      }),
    ).toEqual({ type: "resolved", fallback: false })
  })

  test("selected model wins while provider data catches up", () => {
    expect(
      promptModelFallbackState({
        harnessMode: false,
        hasCurrentModel: false,
        hasSelection: true,
        providerLoading: true,
      }),
    ).toEqual({ type: "selected", fallback: false })

    expect(
      shouldUsePromptFallbackModel({
        harnessMode: false,
        hasCurrentModel: false,
        hasSelection: true,
        providerLoading: true,
      }),
    ).toBe(false)
  })

  test("resolves configured agent variant when model matches", () => {
    expect(
      getConfiguredAgentVariant({
        agent: {
          model: { providerID: "openai", modelID: "gpt-5.2" },
          variant: "xhigh",
        },
        model: {
          providerID: "openai",
          modelID: "gpt-5.2",
          variants: { low: {}, high: {}, xhigh: {} },
        },
      }),
    ).toBe("xhigh")
  })

  test("ignores configured agent variant when model does not match", () => {
    expect(
      getConfiguredAgentVariant({
        agent: {
          model: { providerID: "openai", modelID: "gpt-5.2" },
          variant: "xhigh",
        },
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4",
          variants: { low: {}, high: {}, xhigh: {} },
        },
      }),
    ).toBeUndefined()
  })

  test("prefers selected variant over configured variant", () => {
    expect(
      resolveModelVariant({
        variants: ["low", "high", "xhigh"],
        selected: "high",
        configured: "xhigh",
      }),
    ).toBe("high")
  })

  test("lets an explicit default override the configured variant", () => {
    expect(
      resolveModelVariant({
        variants: ["low", "high", "xhigh"],
        selected: null,
        configured: "xhigh",
      }),
    ).toBeUndefined()
  })

  test("cycles from configured variant to next", () => {
    expect(
      cycleModelVariant({
        variants: ["low", "high", "xhigh"],
        selected: undefined,
        configured: "high",
      }),
    ).toBe("xhigh")
  })

  test("wraps from configured last variant to first", () => {
    expect(
      cycleModelVariant({
        variants: ["low", "high", "xhigh"],
        selected: undefined,
        configured: "xhigh",
      }),
    ).toBe("low")
  })

  test("cycles from an explicit default to the first variant", () => {
    expect(
      cycleModelVariant({
        variants: ["low", "high", "xhigh"],
        selected: null,
        configured: "xhigh",
      }),
    ).toBe("low")
  })

  test("keeps the strategy free of UI and reactive imports", async () => {
    const source = await Bun.file(new URL("./model-strategy.ts", import.meta.url)).text()

    expect(source).not.toMatch(/from "solid-js"/)
    expect(source).not.toMatch(/from "@tanstack\/solid-query"/)
    expect(source).not.toMatch(/from ["'].*components\//)
  })
})

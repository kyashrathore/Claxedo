import { describe, expect, test } from "bun:test"
import { applyCredentialResolution, resolveVerifiedCredentials } from "./credential-resolution"

const defaults = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-5.3-codex",
  "openai-codex": "gpt-5.3-codex",
  cursor: "cursor-default",
}

describe("verified credential resolution", () => {
  test.each([
    {
      name: "anthropic-only",
      credentials: [{ providerId: "anthropic", verification: "ok" }],
      runnableHarnesses: ["claude-acp", "claude-sdk", "pi"],
      defaultHarness: "claude-sdk",
      defaultModel: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    },
    {
      name: "openai-only",
      credentials: [{ providerId: "openai", verification: "ok" }],
      runnableHarnesses: ["codex-acp", "codex-app-server", "opencode", "pi"],
      defaultHarness: "opencode",
      defaultModel: { providerID: "openai", modelID: "gpt-5.3-codex" },
    },
    {
      name: "codex subscription",
      credentials: [{ providerId: "codex-app-server", verification: "ok" }],
      runnableHarnesses: ["codex-acp", "codex-app-server", "opencode", "pi"],
      defaultHarness: "codex-app-server",
      defaultModel: { providerID: "openai-codex", modelID: "gpt-5.3-codex" },
    },
    {
      name: "cursor",
      credentials: [{ providerId: "cursor", verification: "ok" }],
      runnableHarnesses: ["cursor-acp", "cursor-sdk"],
      defaultHarness: "cursor-sdk",
      defaultModel: { providerID: "cursor", modelID: "cursor-default" },
    },
    {
      name: "multi-provider",
      credentials: [
        { providerId: "cursor", verification: "ok" },
        { providerId: "anthropic", verification: "ok" },
        { providerId: "openai", verification: "ok" },
      ],
      runnableHarnesses: [
        "claude-acp",
        "codex-acp",
        "cursor-acp",
        "claude-sdk",
        "codex-app-server",
        "cursor-sdk",
        "opencode",
        "pi",
      ],
      defaultHarness: "opencode",
      defaultModel: { providerID: "openai", modelID: "gpt-5.3-codex" },
    },
    {
      name: "none verified",
      credentials: [
        { providerId: "anthropic", verification: "auth_failed" },
        { providerId: "openai", verification: "expired" },
      ],
      runnableHarnesses: [],
      defaultHarness: undefined,
      defaultModel: undefined,
    },
  ] as const)("resolves $name credentials", (scenario) => {
    expect(resolveVerifiedCredentials({
      credentials: scenario.credentials,
      providerDefaults: defaults,
    })).toEqual({
      runnableHarnesses: scenario.runnableHarnesses,
      defaultHarness: scenario.defaultHarness,
      defaultModel: scenario.defaultModel,
    })
  })

  test("does not invent a model when the provider catalog has no default", () => {
    expect(resolveVerifiedCredentials({
      credentials: [{ providerId: "anthropic", verification: "ok" }],
      providerDefaults: {},
    })).toEqual({
      runnableHarnesses: ["claude-acp", "claude-sdk", "pi"],
      defaultHarness: "claude-sdk",
      defaultModel: undefined,
    })
  })

  test("applies a Claude-only resolution as a submit-ready harness and model", async () => {
    const resolution = resolveVerifiedCredentials({
      credentials: [{ providerId: "anthropic", verification: "ok" }],
      providerDefaults: defaults,
    })
    const applied: { harness?: string; model?: { providerID: string; modelID: string } } = {}

    expect(await applyCredentialResolution({
      resolution,
      setHarness: async (harness) => { applied.harness = harness },
      setModel: async (model) => { applied.model = model },
    })).toBe(true)
    expect(applied).toEqual({
      harness: "claude-sdk",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    })
  })

  test("does not apply a partial resolution with no catalog-backed model", async () => {
    let writes = 0
    expect(await applyCredentialResolution({
      resolution: resolveVerifiedCredentials({
        credentials: [{ providerId: "anthropic", verification: "ok" }],
        providerDefaults: {},
      }),
      setHarness: () => { writes += 1 },
      setModel: () => { writes += 1 },
    })).toBe(false)
    expect(writes).toBe(0)
  })
})

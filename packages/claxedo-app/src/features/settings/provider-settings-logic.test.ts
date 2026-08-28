import { describe, expect, mock, test } from "bun:test"
import {
  canDisconnectProvider,
  disconnectOpenCodeProvider,
  isOpenAiCompatibleConfigProvider,
  nextDisabledProviders,
  patchDisabledProvidersBody,
  patchGlobalDisabledProviders,
  providerSourceTagKey,
  removeProviderAuthEntry,
  resolveProviderDisconnectStrategy,
} from "./provider-settings-logic"

const clineConfig = {
  provider: {
    "clinepass-2": {
      name: "Cline pass 2",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "https://api.cline.bot/api/v1" },
      models: { "cline-pass/kimi-k3": { name: "Kimi K3" } },
    },
  },
  disabled_providers: [] as string[],
}

describe("resolveProviderDisconnectStrategy", () => {
  test("config-sourced providers use disabled_providers (Cline pass regression)", () => {
    expect(resolveProviderDisconnectStrategy({
      source: "config",
      config: clineConfig,
      providerId: "clinepass-2",
    })).toBe("disabled_providers")
  })

  test("custom-sourced providers use disabled_providers", () => {
    expect(resolveProviderDisconnectStrategy({
      source: "custom",
      config: undefined,
      providerId: "my-provider",
    })).toBe("disabled_providers")
  })

  test("API-key providers remove engine auth", () => {
    expect(resolveProviderDisconnectStrategy({
      source: "api",
      config: undefined,
      providerId: "openai",
    })).toBe("auth_remove")
  })

  test("openai-compatible config entries use disabled_providers even without source", () => {
    expect(resolveProviderDisconnectStrategy({
      config: clineConfig,
      providerId: "clinepass-2",
    })).toBe("disabled_providers")
  })
})

describe("isOpenAiCompatibleConfigProvider", () => {
  test("detects config-file custom providers", () => {
    expect(isOpenAiCompatibleConfigProvider(clineConfig, "clinepass-2")).toBe(true)
    expect(isOpenAiCompatibleConfigProvider(clineConfig, "missing")).toBe(false)
  })
})

describe("nextDisabledProviders", () => {
  test("appends provider id once", () => {
    expect(nextDisabledProviders(["a"], "b")).toEqual(["a", "b"])
    expect(nextDisabledProviders(["a", "b"], "b")).toEqual(["a", "b"])
  })
})

describe("providerSourceTagKey", () => {
  test("maps config custom providers to the custom tag", () => {
    expect(providerSourceTagKey({
      source: "config",
      config: clineConfig,
      providerId: "clinepass-2",
    })).toBe("settings.providers.tag.custom")
  })

  test("maps env providers to environment tag", () => {
    expect(providerSourceTagKey({ source: "env", config: undefined, providerId: "anthropic" }))
      .toBe("settings.providers.tag.environment")
  })
})

describe("canDisconnectProvider", () => {
  test("env providers cannot disconnect", () => {
    expect(canDisconnectProvider("env")).toBe(false)
    expect(canDisconnectProvider("api")).toBe(true)
  })
})

describe("patchGlobalDisabledProviders", () => {
  test("uses plain fetch PATCH without assuming JSON response shape", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    await patchGlobalDisabledProviders({
      serverUrl: "http://127.0.0.1:2593",
      disabledProviders: ["clinepass-2"],
      request: async (url, init) => {
        calls.push({ url: String(url), init })
        return new Response("  \u001f not json", { status: 200 })
      },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("http://127.0.0.1:2593/global/config")
    expect(calls[0]?.init?.method).toBe("PATCH")
    expect(calls[0]?.init?.body).toBe(patchDisabledProvidersBody(["clinepass-2"]))
  })

  test("surfaces non-ok responses", async () => {
    await expect(patchGlobalDisabledProviders({
      serverUrl: "http://127.0.0.1:2593",
      disabledProviders: ["x"],
      request: async () => new Response("bad gateway", { status: 502 }),
    })).rejects.toThrow("bad gateway")
  })
})

describe("removeProviderAuthEntry", () => {
  test("drains bare true auth delete bodies without JSON parsing", async () => {
    const url = await removeProviderAuthEntry({
      serverUrl: "http://127.0.0.1:2593",
      providerId: "openai",
      request: async (target, init) => {
        expect(String(target)).toBe("http://127.0.0.1:2593/auth/openai")
        expect(init?.method).toBe("DELETE")
        return new Response("true", { status: 200 })
      },
    })
    expect(url).toBeUndefined()
  })
})

describe("disconnectOpenCodeProvider", () => {
  test("config provider: credentials DELETE then PATCH disabled_providers, not auth DELETE", async () => {
    const calls = { credential: 0, auth: 0, patch: [] as string[], marked: 0, refreshed: false }
    await disconnectOpenCodeProvider({
      providerId: "clinepass-2",
      name: "Cline pass 2",
      source: "config",
      config: clineConfig,
      serverUrl: "http://127.0.0.1:2593",
      deleteCredential: async () => { calls.credential += 1 },
      patchDisabledProviders: async (next) => { calls.patch = next },
      removeAuth: async () => { calls.auth += 1 },
      markDisconnected: () => { calls.marked += 1 },
      refresh: async () => { calls.refreshed = true },
      onSuccess: () => undefined,
      onError: () => undefined,
    })
    expect(calls).toEqual({
      credential: 1,
      auth: 0,
      patch: ["clinepass-2"],
      marked: 2,
      refreshed: true,
    })
  })

  test("API provider: credentials DELETE then auth DELETE", async () => {
    const calls = { credential: 0, auth: 0, patch: [] as string[] }
    await disconnectOpenCodeProvider({
      providerId: "openai",
      name: "OpenAI",
      source: "api",
      config: { provider: {}, disabled_providers: [] },
      serverUrl: "http://127.0.0.1:2593",
      deleteCredential: async () => { calls.credential += 1 },
      patchDisabledProviders: async (next) => { calls.patch = next },
      removeAuth: async () => { calls.auth += 1 },
      markDisconnected: () => undefined,
      refresh: async () => undefined,
      onSuccess: () => undefined,
      onError: () => undefined,
    })
    expect(calls.credential).toBe(1)
    expect(calls.auth).toBe(1)
    expect(calls.patch).toEqual([])
  })

  test("reports patch failures without claiming success", async () => {
    const errors: string[] = []
    const success = mock(() => undefined)
    await disconnectOpenCodeProvider({
      providerId: "clinepass-2",
      name: "Cline pass 2",
      source: "config",
      config: clineConfig,
      serverUrl: "http://127.0.0.1:2593",
      deleteCredential: async () => undefined,
      patchDisabledProviders: async () => {
        throw new Error("Unexpected token")
      },
      removeAuth: async () => undefined,
      markDisconnected: () => undefined,
      refresh: async () => undefined,
      onSuccess: success,
      onError: (message) => errors.push(message),
    })
    expect(success).not.toHaveBeenCalled()
    expect(errors).toEqual(["Unexpected token"])
  })
})

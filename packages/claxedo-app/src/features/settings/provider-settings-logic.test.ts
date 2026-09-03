import { describe, expect, mock, test } from "bun:test"
import {
  canDisconnectProvider,
  disconnectProvider,
  providerDisconnectsThroughConfig,
  providerSourceTagKey,
  removeProviderAuthEntry,
  setProviderDisabled,
} from "./provider-settings-logic"

const unreachable = async () => {
  expect.unreachable()
}

describe("providerSourceTagKey", () => {
  test("maps each provider source to its tag", () => {
    expect(providerSourceTagKey("config")).toBe("settings.providers.tag.config")
    expect(providerSourceTagKey("custom")).toBe("settings.providers.tag.custom")
    expect(providerSourceTagKey("env")).toBe("settings.providers.tag.environment")
    expect(providerSourceTagKey("api")).toBe("settings.providers.tag.apiKey")
    expect(providerSourceTagKey(undefined)).toBe("settings.providers.tag.other")
  })
})

describe("canDisconnectProvider", () => {
  test("env providers cannot disconnect", () => {
    expect(canDisconnectProvider("env")).toBe(false)
    expect(canDisconnectProvider("api")).toBe(true)
  })
})

describe("removeProviderAuthEntry", () => {
  test("drains bare true auth delete bodies without JSON parsing", async () => {
    const url = await removeProviderAuthEntry({
      serverUrl: "http://127.0.0.1:2593",
      providerId: "openai",
      harness: "opencode",
      request: async (target, init) => {
        expect(String(target)).toBe("http://127.0.0.1:2593/auth/openai?harness=opencode")
        expect(init?.method).toBe("DELETE")
        return new Response("true", { status: 200 })
      },
    })
    expect(url).toBeUndefined()
  })

  test("names the workspace scope the entry belongs to", async () => {
    await removeProviderAuthEntry({
      serverUrl: "http://127.0.0.1:2593",
      providerId: "anthropic",
      harness: "claude-sdk",
      directory: "workspace:ws_1",
      request: async (target) => {
        expect(String(target)).toBe(
          "http://127.0.0.1:2593/auth/anthropic?harness=claude-sdk&directory=workspace%3Aws_1",
        )
        return new Response("true", { status: 200 })
      },
    })
  })

  test("surfaces non-ok responses", async () => {
    await expect(removeProviderAuthEntry({
      serverUrl: "http://127.0.0.1:2593",
      providerId: "openai",
      harness: "opencode",
      request: async () => new Response("bad gateway", { status: 502 }),
    })).rejects.toThrow("bad gateway")
  })
})

describe("providerDisconnectsThroughConfig", () => {
  test("only a config-declared row is disconnected by disabling it", () => {
    expect(providerDisconnectsThroughConfig("config")).toBe(true)
    expect(providerDisconnectsThroughConfig("api")).toBe(false)
    expect(providerDisconnectsThroughConfig("custom")).toBe(false)
    expect(providerDisconnectsThroughConfig("env")).toBe(false)
    expect(providerDisconnectsThroughConfig(undefined)).toBe(false)
  })
})

describe("setProviderDisabled", () => {
  test("PATCHes the workspace runtime's provider config for the named scope", async () => {
    const disabled = await setProviderDisabled({
      serverUrl: "http://127.0.0.1:2593",
      providerId: "clinepass-2",
      harness: "opencode",
      directory: "workspace:ws_1",
      disabled: true,
      request: async (target, init) => {
        expect(String(target)).toBe(
          "http://127.0.0.1:2593/api/wr/provider-config?harness=opencode&directory=workspace%3Aws_1",
        )
        expect(init?.method).toBe("PATCH")
        expect(JSON.parse(String(init?.body))).toEqual({ provider: "clinepass-2", disabled: true })
        return Response.json({ harness: "opencode", disabled_providers: ["clinepass-2"] })
      },
    })
    expect(disabled).toEqual(["clinepass-2"])
  })

  test("a scope-less write names the central server's own runtime", async () => {
    await setProviderDisabled({
      serverUrl: "http://127.0.0.1:2593",
      providerId: "clinepass-2",
      harness: "opencode",
      disabled: false,
      request: async (target, init) => {
        expect(String(target)).toBe("http://127.0.0.1:2593/api/wr/provider-config?harness=opencode")
        expect(JSON.parse(String(init?.body))).toEqual({ provider: "clinepass-2", disabled: false })
        return Response.json({ harness: "opencode", disabled_providers: [] })
      },
    })
  })

  test("surfaces non-ok responses", async () => {
    await expect(setProviderDisabled({
      serverUrl: "http://127.0.0.1:2593",
      providerId: "clinepass-2",
      harness: "claude-sdk",
      disabled: true,
      request: async () => new Response("claude-sdk declares no providers", { status: 404 }),
    })).rejects.toThrow("claude-sdk declares no providers")
  })
})

describe("disconnectProvider", () => {
  test("drops the stored credential, then the harness auth entry", async () => {
    const calls = { credential: 0, auth: 0, marked: 0, refreshed: false }
    await disconnectProvider({
      providerId: "openai",
      name: "OpenAI",
      deleteCredential: async () => { calls.credential += 1 },
      removeAuth: async () => { calls.auth += 1 },
      disableInConfig: unreachable,
      markDisconnected: () => { calls.marked += 1 },
      refresh: async () => { calls.refreshed = true },
      onSuccess: () => undefined,
      onError: () => undefined,
    })
    expect(calls).toEqual({ credential: 1, auth: 1, marked: 2, refreshed: true })
  })

  test("a missing credential never blocks the auth removal", async () => {
    let auth = 0
    await disconnectProvider({
      providerId: "openai",
      name: "OpenAI",
      deleteCredential: async () => {
        throw new Error("no stored credential")
      },
      removeAuth: async () => { auth += 1 },
      disableInConfig: unreachable,
      markDisconnected: () => undefined,
      refresh: async () => undefined,
      onSuccess: () => undefined,
      onError: () => expect.unreachable(),
    })
    expect(auth).toBe(1)
  })

  test("reports auth failures without claiming success", async () => {
    const errors: string[] = []
    const success = mock(() => undefined)
    await disconnectProvider({
      providerId: "openai",
      name: "OpenAI",
      deleteCredential: async () => undefined,
      removeAuth: async () => {
        throw new Error("Unexpected token")
      },
      disableInConfig: unreachable,
      markDisconnected: () => undefined,
      refresh: async () => undefined,
      onSuccess: success,
      onError: (message) => errors.push(message),
    })
    expect(success).not.toHaveBeenCalled()
    expect(errors).toEqual(["Unexpected token"])
  })

  test("a config-declared provider is disabled in config, never through auth", async () => {
    const disabled: string[] = []
    const calls = { marked: 0, refreshed: false }
    await disconnectProvider({
      providerId: "clinepass-2",
      name: "Cline pass 2",
      source: "config",
      deleteCredential: unreachable,
      removeAuth: unreachable,
      disableInConfig: async (id) => { disabled.push(id) },
      markDisconnected: () => { calls.marked += 1 },
      refresh: async () => { calls.refreshed = true },
      onSuccess: () => undefined,
      onError: () => expect.unreachable(),
    })
    expect(disabled).toEqual(["clinepass-2"])
    expect(calls).toEqual({ marked: 2, refreshed: true })
  })

  test("a failed config disable reports instead of claiming the row is gone", async () => {
    const errors: string[] = []
    const success = mock(() => undefined)
    const marked = mock(() => undefined)
    await disconnectProvider({
      providerId: "clinepass-2",
      name: "Cline pass 2",
      source: "config",
      deleteCredential: unreachable,
      removeAuth: unreachable,
      disableInConfig: async () => {
        throw new Error("workspace runtime unavailable")
      },
      markDisconnected: marked,
      refresh: unreachable,
      onSuccess: success,
      onError: (message) => errors.push(message),
    })
    expect(success).not.toHaveBeenCalled()
    expect(marked).not.toHaveBeenCalled()
    expect(errors).toEqual(["workspace runtime unavailable"])
  })
})

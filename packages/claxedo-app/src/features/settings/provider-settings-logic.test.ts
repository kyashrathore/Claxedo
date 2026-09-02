import { describe, expect, mock, test } from "bun:test"
import {
  canDisconnectProvider,
  disconnectProvider,
  providerSourceTagKey,
  removeProviderAuthEntry,
} from "./provider-settings-logic"

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

describe("disconnectProvider", () => {
  test("drops the stored credential, then the harness auth entry", async () => {
    const calls = { credential: 0, auth: 0, marked: 0, refreshed: false }
    await disconnectProvider({
      providerId: "openai",
      name: "OpenAI",
      deleteCredential: async () => { calls.credential += 1 },
      removeAuth: async () => { calls.auth += 1 },
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
      markDisconnected: () => undefined,
      refresh: async () => undefined,
      onSuccess: success,
      onError: (message) => errors.push(message),
    })
    expect(success).not.toHaveBeenCalled()
    expect(errors).toEqual(["Unexpected token"])
  })
})

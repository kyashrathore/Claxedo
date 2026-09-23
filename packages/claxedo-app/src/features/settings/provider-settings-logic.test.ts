import { describe, expect, mock, test } from "bun:test"
import {
  canDisconnectProvider,
  disconnectProvider,
  providerSourceTagKey,
  removeProviderAuthEntry,
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

describe("disconnectProvider", () => {
  test("drops the stored credential, then the harness auth entry", async () => {
    const calls: string[] = []
    await disconnectProvider({
      providerId: "openai",
      name: "OpenAI",
      source: "api",
      deleteCredential: async (id) => { calls.push(`credential:${id}`) },
      removeAuth: async (id) => { calls.push(`auth:${id}`) },
      markDisconnected: (id) => { calls.push(`mark:${id}`) },
      refresh: async () => { calls.push("refresh") },
      onSuccess: (name) => { calls.push(`success:${name}`) },
      onError: () => expect.unreachable(),
    })
    expect(calls).toEqual(["credential:openai", "auth:openai", "mark:openai", "success:OpenAI", "refresh", "mark:openai"])
  })

  test("a missing credential never blocks the auth removal", async () => {
    let auth = 0
    await disconnectProvider({
      providerId: "openai",
      name: "OpenAI",
      source: "api",
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
      source: "api",
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

  test("configuration-owned providers cannot mutate credentials or claim disconnection", async () => {
    const errors: string[] = []
    await disconnectProvider({
      providerId: "external", name: "External", source: "config",
      deleteCredential: unreachable, removeAuth: unreachable,
      markDisconnected: () => expect.unreachable(), refresh: unreachable,
      onSuccess: () => expect.unreachable(), onError: (error) => errors.push(error),
    })
    expect(errors).toEqual(["This provider is managed by the connected harness"])
    expect(canDisconnectProvider("config")).toBe(false)
    expect(canDisconnectProvider(undefined)).toBe(false)
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import {
  cachedSdkRuntimeRequest,
  resetSdkRuntimeRequestCacheForTest,
  sdkRuntimeRequestQueryKey,
} from "./sdk"

afterEach(() => {
  resetSdkRuntimeRequestCacheForTest()
})

describe("sdk runtime request cache", () => {
  test("uses a provider-scoped shell query key", () => {
    expect(sdkRuntimeRequestQueryKey({
      owner: "sdk-a",
      serverUrl: "http://localhost:3001",
      directory: "/repo/main",
      workspaceId: "ws_1",
    })).toEqual([
      "shell",
      "sdk-runtime-request",
      "sdk-a",
      "http://localhost:3001",
      "/repo/main",
      "ws_1",
    ])
  })

  test("dedupes runtime request wrappers through Query", () => {
    const request = async () => Response.json({ ok: true })
    const input = {
      owner: "sdk-a",
      serverUrl: "http://localhost:3001",
      directory: "/repo/main",
      workspaceId: "ws_1",
      request,
      relayRequest: request,
    }

    expect(cachedSdkRuntimeRequest(input)).toBe(cachedSdkRuntimeRequest(input))
  })

  test("keeps different provider owners isolated", () => {
    const request = async () => Response.json({ ok: true })
    const base = {
      serverUrl: "http://localhost:3001",
      directory: "/repo/main",
      workspaceId: "ws_1",
      request,
      relayRequest: request,
    }

    expect(cachedSdkRuntimeRequest({ ...base, owner: "sdk-a" })).not.toBe(
      cachedSdkRuntimeRequest({ ...base, owner: "sdk-b" }),
    )
  })

  test("reset clears cached runtime request wrappers", () => {
    const request = async () => Response.json({ ok: true })
    const input = {
      owner: "sdk-a",
      serverUrl: "http://localhost:3001",
      directory: "/repo/main",
      workspaceId: "ws_1",
      request,
      relayRequest: request,
    }
    const first = cachedSdkRuntimeRequest(input)

    resetSdkRuntimeRequestCacheForTest()

    expect(cachedSdkRuntimeRequest(input)).not.toBe(first)
  })

  test("keeps SDK runtime request dedupe out of private maps", async () => {
    const source = await Bun.file(new URL("./sdk.tsx", import.meta.url)).text()

    expect(source).not.toContain("runtimeRequests = new Map")
    expect(source).not.toContain("const runtimeRequests")
  })

  test("keeps SDK runtime routing off the gateway facade", async () => {
    const source = await Bun.file(new URL("./sdk.tsx", import.meta.url)).text()

    expect(source).not.toContain("RuntimeGateway.")
  })
})

import { afterEach, describe, expect, test } from "bun:test"
// Imported from `./runtime-request`, not `./sdk`: several unrelated suites stub
// `@/app/providers/sdk/sdk` with `mock.module`, which replaces the module for
// the whole `bun test` process, so importing these from there fails depending
// on file order.
import {
  cachedSdkRuntimeRequest,
  resetSdkRuntimeRequestCacheForTest,
  sdkRuntimeRequestQueryKey,
  sdkWorkspaceTransport,
} from "./runtime-request"

afterEach(() => {
  resetSdkRuntimeRequestCacheForTest()
})

describe("sdk runtime request cache", () => {
  test("uses a provider-scoped shell query key", () => {
    expect(
      sdkRuntimeRequestQueryKey({
        owner: "sdk-a",
        serverUrl: "http://localhost:3001",
        directory: "/repo/main",
        workspaceId: "ws_1",
      }),
    ).toEqual(["shell", "sdk-runtime-request", "sdk-a", "http://localhost:3001", "/repo/main", "ws_1", "unsigned"])
  })

  test("signed loopback workspace scopes use the relay", () => {
    expect(
      sdkWorkspaceTransport({
        serverUrl: "http://127.0.0.1:3001",
        workspaceId: "ws_signed",
        signedAccess: true,
      }),
    ).toBe("workspace-relay")
  })

  test("unsigned desktop loopback scopes remain local", () => {
    expect(
      sdkWorkspaceTransport({
        serverUrl: "http://127.0.0.1:3001",
        workspaceId: "ws_local",
        signedAccess: false,
      }),
    ).toBe("loopback")
  })

  test("remote workspace scopes continue to use the relay", () => {
    expect(
      sdkWorkspaceTransport({
        serverUrl: "https://control.example",
        workspaceId: "ws_remote",
        signedAccess: false,
      }),
    ).toBe("workspace-relay")
  })

  test("runtime request cache isolates signed and unsigned transports", () => {
    const request = async () => Response.json({ ok: true })
    const input = {
      owner: "sdk-a",
      serverUrl: "http://127.0.0.1:3001",
      directory: "/repo/main",
      workspaceId: "ws_1",
      request,
      relayRequest: request,
    }

    expect(cachedSdkRuntimeRequest({ ...input, signedAccess: true })).not.toBe(
      cachedSdkRuntimeRequest({ ...input, signedAccess: false }),
    )
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
    for (const file of ["./sdk.tsx", "./runtime-request.ts"]) {
      const source = await Bun.file(new URL(file, import.meta.url)).text()

      expect(source).not.toContain("runtimeRequests = new Map")
      expect(source).not.toContain("const runtimeRequests")
    }
  })

  test("keeps SDK runtime routing off the gateway facade", async () => {
    for (const file of ["./sdk.tsx", "./runtime-request.ts"]) {
      const source = await Bun.file(new URL(file, import.meta.url)).text()

      expect(source).not.toContain("RuntimeGateway.")
    }
  })
})

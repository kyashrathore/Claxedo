import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"

/**
 * The bridge drives the engine's own control routes through the injected
 * transport, so these tests point the transport at a stub engine that records
 * requests and keeps an in-memory auth store shaped like the engine's.
 */

let dataDir: string

const engine = {
  auth: new Map<string, unknown>(),
  requests: [] as Array<{ method: string; pathname: string; body?: unknown }>,
  disposed: 0,
  failNextWrite: false,
}

function resetEngine() {
  engine.auth.clear()
  engine.requests = []
  engine.disposed = 0
  engine.failNextWrite = false
}

async function stubEngineFetch(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const body = ["PUT", "POST"].includes(request.method)
    ? await request.json().catch(() => undefined)
    : undefined
  engine.requests.push({ method: request.method, pathname: url.pathname, body })

  if (url.pathname === "/global/dispose") {
    engine.disposed += 1
    return Response.json(true)
  }

  const match = /^\/auth\/(.+)$/.exec(url.pathname)
  if (match) {
    const provider = decodeURIComponent(match[1]!)
    if (request.method === "PUT") {
      if (engine.failNextWrite) {
        engine.failNextWrite = false
        return Response.json({ error: "bad request" }, { status: 400 })
      }
      // Mirror the engine's schema gate: only the Auth.Info variants decode.
      const value = body as Record<string, unknown> | undefined
      if (!value || (value.type !== "api" && value.type !== "oauth" && value.type !== "wellknown")) {
        return Response.json({ error: "bad payload" }, { status: 400 })
      }
      engine.auth.set(provider, value)
      return Response.json(true)
    }
    if (request.method === "DELETE") {
      engine.auth.delete(provider)
      return Response.json(true)
    }
  }
  return Response.json({ error: "not found" }, { status: 404 })
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-engine-bridge-"))
  process.env.CLAXEDO_DATA_DIR = dataDir
  delete process.env.OPENCODE_AUTH_CONTENT
  resetEngine()
  vi.resetModules()
})

afterEach(() => {
  delete process.env.CLAXEDO_DATA_DIR
  delete process.env.OPENCODE_AUTH_CONTENT
  fs.rmSync(dataDir, { recursive: true, force: true })
})

/**
 * Load the bridge with the engine transport stubbed. `opencode-engine` is
 * mocked rather than driven in URL mode so no socket is involved.
 */
async function loadBridge() {
  vi.doMock("../../opencode/engine", () => ({
    OPENCODE_INTERNAL_BASE: "http://opencode.internal",
    opencodeRequest: (request: Request) => stubEngineFetch(request),
  }))
  const registry = await import("./registry")
  const bridge = await import("./engine-bridge")
  return { registry, bridge }
}

describe("credential → engine auth bridge", () => {
  test("boot sync makes a stored anthropic key visible to the engine", async () => {
    const { registry, bridge } = await loadBridge()
    await registry.putCredential({
      provider_id: "anthropic",
      kind: "api_key",
      source: "managed",
      secret: "sk-ant-api03-stored",
    })

    const result = await bridge.syncCredentialsToEngine()

    expect(result.synced).toContain("anthropic")
    expect(engine.auth.get("anthropic")).toEqual({ type: "api", key: "sk-ant-api03-stored" })
  })

  test("a live update reaches the engine and invalidates its cached provider state", async () => {
    const { registry, bridge } = await loadBridge()
    await registry.putCredential({
      provider_id: "anthropic",
      kind: "api_key",
      source: "managed",
      secret: "sk-ant-old",
    })
    await bridge.syncCredentialsToEngine()
    const disposesAfterBoot = engine.disposed

    await registry.putCredential({
      provider_id: "anthropic",
      kind: "api_key",
      source: "managed",
      secret: "sk-ant-new",
    })
    await bridge.syncCredentialsToEngine()

    expect(engine.auth.get("anthropic")).toEqual({ type: "api", key: "sk-ant-new" })
    // Without a dispose the engine's ScopedCache would keep serving the old key
    // for the life of the process — this is the "updated my key, still fails" bug.
    expect(engine.disposed).toBeGreaterThan(disposesAfterBoot)
  })

  test("deleting the credential in Claxedo removes the bridged engine entry", async () => {
    const { registry, bridge } = await loadBridge()
    const cred = await registry.putCredential({
      provider_id: "anthropic",
      kind: "api_key",
      source: "managed",
      secret: "sk-ant-doomed",
    })
    await bridge.syncCredentialsToEngine()
    expect(engine.auth.has("anthropic")).toBe(true)

    await registry.deleteCredential(cred.id)
    const result = await bridge.syncCredentialsToEngine()

    expect(result.removed).toContain("anthropic")
    expect(engine.auth.has("anthropic")).toBe(false)
  })

  test("non-AI credential kinds and namespaced ids are never bridged", async () => {
    const { registry, bridge } = await loadBridge()
    await registry.putCredential({
      provider_id: "daytona",
      kind: "sandbox_driver",
      source: "managed",
      secret: "dtn-driver-token",
    })
    await registry.putCredential({
      provider_id: "integration:github",
      kind: "oauth_token",
      source: "managed",
      secret: "gho-connection-token",
    })

    const result = await bridge.syncCredentialsToEngine()

    expect(result.synced).toEqual([])
    expect(engine.auth.size).toBe(0)
    const wrote = engine.requests.filter((r) => r.method === "PUT")
    expect(wrote).toEqual([])
  })

  test("engine-side manual auth for an unmanaged provider is left untouched", async () => {
    const { registry, bridge } = await loadBridge()
    // The user connected deepseek directly in the engine's model picker.
    engine.auth.set("deepseek", { type: "api", key: "sk-deepseek-user-set" })
    await registry.putCredential({
      provider_id: "anthropic",
      kind: "api_key",
      source: "managed",
      secret: "sk-ant-managed",
    })

    await bridge.syncCredentialsToEngine()

    expect(engine.auth.get("deepseek")).toEqual({ type: "api", key: "sk-deepseek-user-set" })
    const touchedDeepseek = engine.requests.some((r) => r.pathname === "/auth/deepseek")
    expect(touchedDeepseek).toBe(false)
  })

  test("a manually-connected key for a MANAGED provider survives an unrelated sync", async () => {
    const { registry, bridge } = await loadBridge()
    // openai is a provider the registry is allowed to manage, but has never
    // written. The user connected it in the engine's own model picker. Sweeping
    // every managed provider on sync would delete it — same bug, other direction.
    engine.auth.set("openai", { type: "api", key: "sk-openai-user-set" })
    await registry.putCredential({
      provider_id: "anthropic",
      kind: "api_key",
      source: "managed",
      secret: "sk-ant-managed",
    })

    await bridge.syncCredentialsToEngine()

    expect(engine.auth.get("openai")).toEqual({ type: "api", key: "sk-openai-user-set" })
    expect(engine.requests.some((r) => r.pathname === "/auth/openai")).toBe(false)
  })

  test("a bare anthropic row wins over a claude-sdk alias for the same engine provider", async () => {
    const { registry, bridge } = await loadBridge()
    await registry.putCredential({
      provider_id: "claude-sdk",
      kind: "api_key",
      source: "managed",
      secret: "sk-ant-alias",
    })
    await registry.putCredential({
      provider_id: "anthropic",
      kind: "api_key",
      source: "managed",
      secret: "sk-ant-canonical",
    })

    await bridge.syncCredentialsToEngine()

    expect(engine.auth.get("anthropic")).toEqual({ type: "api", key: "sk-ant-canonical" })
  })

  test("credentials are written as the api Auth.Info variant the provider layer consumes", async () => {
    const { registry, bridge } = await loadBridge()
    // An oauth-shaped payload would decode against Auth.Info and then be
    // ignored at model construction — anthropic has no plugin auth loader.
    await registry.putCredential({
      provider_id: "anthropic",
      kind: "oauth_token",
      source: "managed",
      secret: "sk-ant-oat01-setup-token",
    })

    await bridge.syncCredentialsToEngine()

    expect(engine.auth.get("anthropic")).toEqual({ type: "api", key: "sk-ant-oat01-setup-token" })
  })

  test("a failing engine write is not reported as synced and does not throw", async () => {
    const { registry, bridge } = await loadBridge()
    await registry.putCredential({
      provider_id: "anthropic",
      kind: "api_key",
      source: "managed",
      secret: "sk-ant-key",
    })
    engine.failNextWrite = true

    const result = await bridge.syncCredentialsToEngine()

    expect(result.synced).not.toContain("anthropic")
  })

  test("OPENCODE_AUTH_CONTENT shadowing is reported rather than silently inert", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ anthropic: { type: "api", key: "sk-env" } })
    const { registry, bridge } = await loadBridge()
    bridge.__resetEngineBridgeWarningsForTests()
    await registry.putCredential({
      provider_id: "anthropic",
      kind: "api_key",
      source: "managed",
      secret: "sk-ant-key",
    })

    const result = await bridge.syncCredentialsToEngine()

    expect(result.shadowed).toBe(true)
  })
})

import { afterEach, describe, expect, test, vi } from "vitest"
import type { ProviderProjection } from "@claxedo/agent-sdk-runtime"
import { configureAgentConfig, disposeAgentConfig } from "../agent-config/index"

const loaded = vi.fn(() => false)
const construct = vi.fn(() => { throw new Error("a credential write must not boot the SDK") })
vi.mock("./sdk-runtime", () => ({
  openCodeSdkRuntimeLoaded: () => loaded(),
  openCodeSdkRuntime: () => construct(),
}))

const brokerProjection = {
  baseUrl: "http://127.0.0.1:2595/bindings/aa11",
  placeholder: "signed-placeholder",
  authMode: "bearer" as const,
  expiresAt: 1_800_000_000_000,
  apiPath: "/v1",
}

/** An engine whose provider routing and credential store can both be read back. */
function fakeRuntime(connections: { id: string; label: string }[] = []) {
  const removed: string[] = []
  const bound: Record<string, unknown>[] = []
  return {
    removed,
    bound,
    runtime: {
      configuration: {
        integrations: async () => [{
          id: "anthropic",
          name: "Anthropic",
          methods: [],
          connections: connections.map((row) => ({ type: "credential" as const, id: row.id, label: row.label })),
        }],
        removeCredential: async (id: string) => { removed.push(id) },
        connectKey: async () => { throw new Error("the bridge must not store a plaintext key in the SDK") },
      },
      bindProviders: async (overlays: Record<string, unknown>) => { bound.push(overlays) },
    },
  }
}

describe("OpenCode SDK credential bridge", () => {
  afterEach(() => {
    disposeAgentConfig()
    loaded.mockReset()
    construct.mockReset()
    loaded.mockReturnValue(false)
  })

  test("a credential write against a cold SDK host is deferred to the boot reconcile", async () => {
    const { syncCredentialsToSdk } = await import("./sdk-credential-bridge")
    await expect(syncCredentialsToSdk()).resolves.toEqual({ bound: [], removed: [] })
    expect(construct).not.toHaveBeenCalled()
  })

  test("a running SDK host receives the write", async () => {
    loaded.mockReturnValue(true)
    construct.mockImplementation(() => { throw new Error("a credential write must not boot the SDK") })
    const { syncCredentialsToSdk } = await import("./sdk-credential-bridge")
    await expect(syncCredentialsToSdk()).rejects.toThrow("a credential write must not boot the SDK")
    expect(construct).toHaveBeenCalledTimes(1)
  })

  test("a bound account becomes provider routing, never a stored credential", async () => {
    const fake = fakeRuntime([{ id: "cred-old", label: "Claxedo managed: anthropic" }])
    construct.mockImplementation(() => fake.runtime as never)
    const auth: Record<string, ProviderProjection> = { "claude-sdk": brokerProjection }
    configureAgentConfig({ projectAuth: async () => auth })

    const { reconcileCredentialsIntoSdk } = await import("./sdk-credential-bridge")
    await expect(reconcileCredentialsIntoSdk()).resolves.toEqual({ bound: ["anthropic"], removed: ["anthropic"] })

    expect(fake.bound).toEqual([{
      anthropic: { baseURL: "http://127.0.0.1:2595/bindings/aa11/v1", apiKey: "signed-placeholder" },
    }])
    expect(fake.removed).toEqual(["cred-old"])
  })

  test("an unavailable account leaves the provider unbound rather than on the machine's login", async () => {
    const fake = fakeRuntime()
    construct.mockImplementation(() => fake.runtime as never)
    const auth: Record<string, ProviderProjection> = {
      "claude-sdk": { unavailable: true, reason: "auth_failed" },
      openai: brokerProjection,
    }
    configureAgentConfig({ projectAuth: async () => auth })

    const { reconcileCredentialsIntoSdk } = await import("./sdk-credential-bridge")
    await reconcileCredentialsIntoSdk()

    expect(fake.bound).toEqual([{
      openai: { baseURL: "http://127.0.0.1:2595/bindings/aa11/v1", apiKey: "signed-placeholder" },
    }])
  })
})

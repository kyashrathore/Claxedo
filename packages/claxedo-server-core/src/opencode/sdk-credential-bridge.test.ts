import { afterEach, describe, expect, test, vi } from "vitest"
import type { ProviderProjection } from "@claxedo/agent-sdk-runtime"
import { configureAgentConfig, disposeAgentConfig } from "../agent-config/index"
import { reconcileCredentialsIntoSdk, renewSdkCredentialsIfDue, syncCredentialsToSdk } from "./sdk-credential-bridge"

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

const PROVIDER_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY"] as const
const savedEnv = Object.fromEntries(PROVIDER_ENV.map((name) => [name, process.env[name]]))

describe("OpenCode SDK credential bridge", () => {
  afterEach(() => {
    for (const name of PROVIDER_ENV) {
      if (savedEnv[name] === undefined) delete process.env[name]
      else process.env[name] = savedEnv[name]
    }
    disposeAgentConfig()
    loaded.mockReset()
    construct.mockReset()
    loaded.mockReturnValue(false)
  })

  test("a credential write against a cold SDK host is deferred to the boot reconcile", async () => {
    await expect(syncCredentialsToSdk()).resolves.toEqual({ bound: [], removed: [] })
    expect(construct).not.toHaveBeenCalled()
  })

  test("a running SDK host receives the write", async () => {
    loaded.mockReturnValue(true)
    construct.mockImplementation(() => { throw new Error("a credential write must not boot the SDK") })
    await expect(syncCredentialsToSdk()).rejects.toThrow("a credential write must not boot the SDK")
    expect(construct).toHaveBeenCalledTimes(1)
  })

  test("a bound account becomes provider routing, never a stored credential", async () => {
    const fake = fakeRuntime([{ id: "cred-old", label: "Claxedo managed: anthropic" }])
    construct.mockImplementation(() => fake.runtime as never)
    const auth: Record<string, ProviderProjection> = { "claude-sdk": brokerProjection }
    configureAgentConfig({ projectAuth: async () => auth })

    await expect(reconcileCredentialsIntoSdk()).resolves.toEqual({ bound: ["anthropic"], removed: ["anthropic"] })

    expect(fake.bound).toEqual([{
      anthropic: { baseURL: "http://127.0.0.1:2595/bindings/aa11/v1", apiKey: "signed-placeholder" },
    }])
    expect(fake.removed).toEqual(["cred-old"])
  })

  test("every provider the broker has a destination for reaches the engine as routing", async () => {
    const fake = fakeRuntime()
    construct.mockImplementation(() => fake.runtime as never)
    // The four below reached the engine as a plaintext copy of the stored key
    // until the broker took over delivery; an id missing here reaches it not at
    // all, which is a working account silently going dark.
    const registryIds = ["claude-sdk", "openai", "openrouter", "google", "groq", "xai"] as const
    const auth = Object.fromEntries(registryIds.map((id) => [id, brokerProjection])) as Record<string, ProviderProjection>
    configureAgentConfig({ projectAuth: async () => auth })

    await reconcileCredentialsIntoSdk()

    expect(Object.keys(fake.bound[0]).sort())
      .toEqual(["anthropic", "google", "groq", "openai", "openrouter", "xai"])
  })

  test("an unavailable account reaches the engine as unavailable, not as silence", async () => {
    const fake = fakeRuntime()
    construct.mockImplementation(() => fake.runtime as never)
    const auth: Record<string, ProviderProjection> = {
      "claude-sdk": { unavailable: true, reason: "auth_failed" },
      openai: brokerProjection,
    }
    configureAgentConfig({ projectAuth: async () => auth })

    await reconcileCredentialsIntoSdk()

    // Silence is what the engine reads as "no account chosen", and it answers
    // that by running the turn on its own login.
    expect(fake.bound).toEqual([{
      anthropic: { unavailable: true, reason: "auth_failed" },
      openai: { baseURL: "http://127.0.0.1:2595/bindings/aa11/v1", apiKey: "signed-placeholder" },
    }])
  })

  test("a row this process cannot project disables its own provider and no other", async () => {
    const fake = fakeRuntime()
    construct.mockImplementation(() => fake.runtime as never)
    configureAgentConfig({
      projectAuth: async () => ({
        "claude-sdk": { ...brokerProjection, authMode: "basic" },
        openai: brokerProjection,
      } as unknown as Record<string, ProviderProjection>),
    })

    await reconcileCredentialsIntoSdk()

    expect(fake.bound).toEqual([{
      anthropic: { unavailable: true, reason: "unresolved_projection" },
      openai: { baseURL: "http://127.0.0.1:2595/bindings/aa11/v1", apiKey: "signed-placeholder" },
    }])
  })

  test("an unavailable alias never disables a provider another account has bound", async () => {
    const fake = fakeRuntime()
    construct.mockImplementation(() => fake.runtime as never)
    // `anthropic` and `claude-sdk` are one engine provider. Written in order,
    // the second row wins and a working account goes dark behind the other's
    // refusal.
    const auth: Record<string, ProviderProjection> = {
      anthropic: brokerProjection,
      "claude-sdk": { unavailable: true, reason: "auth_failed" },
      "codex-app-server": { unavailable: true, reason: "revoked" },
      openai: brokerProjection,
    }
    configureAgentConfig({ projectAuth: async () => auth })

    await reconcileCredentialsIntoSdk()

    expect(fake.bound).toEqual([{
      anthropic: { baseURL: "http://127.0.0.1:2595/bindings/aa11/v1", apiKey: "signed-placeholder" },
      openai: { baseURL: "http://127.0.0.1:2595/bindings/aa11/v1", apiKey: "signed-placeholder" },
    }])
  })

  test("two bound accounts for one engine provider are decided by the exact id", async () => {
    const fake = fakeRuntime()
    construct.mockImplementation(() => fake.runtime as never)
    const auth: Record<string, ProviderProjection> = {
      "claude-sdk": { ...brokerProjection, placeholder: "alias-placeholder" },
      anthropic: { ...brokerProjection, placeholder: "exact-placeholder" },
    }
    configureAgentConfig({ projectAuth: async () => auth })

    await reconcileCredentialsIntoSdk()

    expect(fake.bound[0].anthropic).toMatchObject({ apiKey: "exact-placeholder" })
  })

  test("a bound provider's own environment variable is withheld from the engine's process", async () => {
    const fake = fakeRuntime()
    construct.mockImplementation(() => fake.runtime as never)
    // `ModelResolver.load` resolves an env connection ahead of the overlay and
    // substitutes its key for the placeholder, so the operator's real key would
    // be the value sent to the broker URL — which refuses it.
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-operator-own"
    process.env.ANTHROPIC_AUTH_TOKEN = "operator-own-oauth"
    process.env.OPENAI_API_KEY = "sk-operator-openai"
    configureAgentConfig({ projectAuth: async () => ({ "claude-sdk": brokerProjection }) })

    await reconcileCredentialsIntoSdk()

    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    // Nobody chose an OpenAI account, so the engine keeps its own auth for it
    // and every other harness keeps the implicit tier.
    expect(process.env.OPENAI_API_KEY).toBe("sk-operator-openai")
  })

  test("an account the operator removes hands the environment back", async () => {
    const fake = fakeRuntime()
    construct.mockImplementation(() => fake.runtime as never)
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-operator-own"
    let auth: Record<string, ProviderProjection> = { "claude-sdk": brokerProjection }
    configureAgentConfig({ projectAuth: async () => auth })

    await reconcileCredentialsIntoSdk()
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()

    auth = {}
    await reconcileCredentialsIntoSdk()

    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-api03-operator-own")
  })

  test("the engine's placeholders are re-projected when they are half spent, and not before", async () => {
    const fake = fakeRuntime()
    construct.mockImplementation(() => fake.runtime as never)
    loaded.mockReturnValue(true)
    const projectedAt = Date.now()
    configureAgentConfig({
      projectAuth: async (): Promise<Record<string, ProviderProjection>> => ({
        "claude-sdk": { ...brokerProjection, expiresAt: Date.now() + 60 * 60 * 1000 },
      }),
    })

    await reconcileCredentialsIntoSdk()
    expect(fake.bound).toHaveLength(1)

    await renewSdkCredentialsIfDue({ at: projectedAt + 29 * 60 * 1000 })
    expect(fake.bound).toHaveLength(1)

    await renewSdkCredentialsIfDue({ at: projectedAt + 31 * 60 * 1000 })
    expect(fake.bound).toHaveLength(2)
  })

  test("a cold engine holds no placeholder and is never renewed", async () => {
    await expect(renewSdkCredentialsIfDue({ at: Date.now(), all: true })).resolves.toBeUndefined()
    expect(construct).not.toHaveBeenCalled()
  })
})

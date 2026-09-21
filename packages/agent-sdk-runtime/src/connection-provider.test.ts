import { describe, expect, test } from "bun:test"
import { decodeHarnessConnectionsCatalog } from "@claxedo/agent-runtime-contract"
import type { AgentHarnessAdapter } from "./adapter-contract"
import {
  ConnectionProviderError,
  createConnectionProviderRegistry,
  type ConnectionProvider,
  type HarnessConnectionCapabilities,
  type HarnessConnectionDescriptor,
} from "./connection-provider"
import { createRuntimeEventHub } from "./runtime-event-hub"
import { AcpHarnessAdapter } from "./harnesses/acp"
import { createAcpConnectionProvider } from "./harnesses/acp/connection-provider"
import type { AgentRuntimeStoreWithRecovery } from "./harnesses/shared/runtime-store"

const capabilities: HarnessConnectionCapabilities = {
  abort: false,
  reconnect: false,
  replay: false,
  permissions: false,
  questions: false,
  todos: false,
  commands: false,
  fork: false,
  revert: false,
  unrevert: false,
  configOptions: false,
  subagents: false,
}

const fixtureAdapter = { fixture: true } as unknown as AgentHarnessAdapter

const fixtureProvider: ConnectionProvider<{ label: string }> = {
  providerKey: "fixture",
  validateConfig(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("config must be an object")
    const label = (input as Record<string, unknown>).label
    if (typeof label !== "string" || !label) throw new Error("label is required")
    return { label }
  },
  project(config) {
    return { label: config.label, readiness: "ready", capabilities }
  },
  resolve({ descriptor }) {
    return { config: descriptor.config }
  },
  createAdapter() {
    return fixtureAdapter
  },
}

const context = {
  store: {} as AgentRuntimeStoreWithRecovery,
  eventHub: createRuntimeEventHub(),
}

function fixtureDescriptor(overrides: Partial<HarnessConnectionDescriptor<{ label: string }>> = {}) {
  return {
    connectionId: "fixture-primary",
    providerKey: "fixture",
    configRevision: 3,
    enabled: true,
    config: { label: "Fixture provider" },
    ...overrides,
  }
}

describe("connection provider registry", () => {
  test("rejects connection identities the session harness cannot persist, before provider effects", async () => {
    let providerCalls = 0
    const registry = createConnectionProviderRegistry([{
      ...fixtureProvider,
      validateConfig(input) { providerCalls++; return fixtureProvider.validateConfig(input) },
    }])
    for (const connectionId of ["adoption_fixture", "with/slash", " agent", "Agent", "0agent", "a".repeat(65)]) {
      await expect(registry.resolve({ descriptor: fixtureDescriptor({ connectionId }), directory: "/workspace", context }))
        .rejects.toMatchObject({ code: "invalid_descriptor" })
    }
    expect(providerCalls).toBe(0)
    const valid = fixtureDescriptor({ connectionId: "a".repeat(64) })
    expect(registry.validateDescriptor(valid)).toEqual(valid)
  })

  test("keeps trusted provider config out of its browser-safe reference", () => {
    const registry = createConnectionProviderRegistry([createAcpConnectionProvider(), fixtureProvider])
    const ref = registry.publicRef({
      connectionId: "remote-acp",
      providerKey: "acp",
      configRevision: 7,
      enabled: true,
      config: {
        label: "Remote ACP",
        connection: {
          kind: "streamable-http",
          url: "https://agent.example.test/acp",
        },
        secretBindings: { headers: { authorization: "token" } },
        modelSelection: { status: "unsupported" },
      },
    })

    expect(ref).toEqual({
      connectionId: "remote-acp",
      label: "Remote ACP",
      enabled: true,
      readiness: "configured",
      capabilities: {
        abort: true,
        reconnect: false,
        replay: true,
        permissions: true,
        questions: true,
        todos: false,
        commands: false,
        fork: false,
        revert: false,
        unrevert: false,
        configOptions: true,
        subagents: false,
      },
      modelSelection: { status: "unsupported" },
    })
    expect(JSON.stringify(ref)).not.toContain("secret")
    expect(ref).not.toHaveProperty("providerKey")
    expect(ref).not.toHaveProperty("configRevision")
    expect(ref).not.toHaveProperty("config")
    expect(decodeHarnessConnectionsCatalog(JSON.parse(JSON.stringify({ status: "supported", connections: [ref] })))).toEqual({
      status: "supported", connections: [ref],
    })
  })

  test("resolves generic remote ACP without a process command or fake binary", async () => {
    const registry = createConnectionProviderRegistry([createAcpConnectionProvider()])
    const result = await registry.resolve({
      descriptor: {
        connectionId: "remote-acp",
        providerKey: "acp",
        configRevision: 11,
        enabled: true,
        config: {
          label: "Remote ACP",
          connection: { kind: "websocket", url: "wss://agent.example.test/acp" },
          modelSelection: { status: "optional" },
        },
      },
      directory: "/workspace",
      context,
    })

    expect(result.adapter).toBeInstanceOf(AcpHarnessAdapter)
    expect(result.connectionGeneration).toEqual({ configRevision: 11, secretLeaseGeneration: "none" })
  })

  test("materializes ACP secret bindings only inside the resolved provider config", async () => {
    const provider = createAcpConnectionProvider()
    const descriptor = {
      connectionId: "remote-acp",
      providerKey: "acp",
      configRevision: 1,
      enabled: true,
      config: provider.validateConfig({
        label: "Remote ACP",
        connection: { kind: "streamable-http", url: "https://agent.example.test/acp" },
        secretBindings: { headers: { authorization: "token" } },
      }),
      secretRefs: { token: "credentials/agent-token" },
    }

    const resolved = await provider.resolve({ descriptor, directory: "/workspace", secrets: { token: "Bearer secret" } })
    expect(resolved.config.connection).toEqual({
      kind: "streamable-http",
      url: "https://agent.example.test/acp",
      headers: { authorization: "Bearer secret" },
    })
    expect(JSON.stringify(provider.project(descriptor.config))).not.toContain("Bearer secret")
    await expect(Promise.resolve().then(() => provider.resolve({ descriptor, directory: "/workspace", secrets: {} }))).rejects.toMatchObject({
      code: "connection_unavailable",
    })
  })

  test("resolves an unrelated installed provider without an ACP branch", async () => {
    const registry = createConnectionProviderRegistry([createAcpConnectionProvider(), fixtureProvider])
    const result = await registry.resolve({ descriptor: fixtureDescriptor(), directory: "/workspace", context })
    expect(result.adapter).toBe(fixtureAdapter)
    expect(result.connectionGeneration).toEqual({ configRevision: 3, secretLeaseGeneration: "none" })
  })

  test("fails closed for unknown, disabled, duplicate, and invalid connections", async () => {
    const registry = createConnectionProviderRegistry([createAcpConnectionProvider(), fixtureProvider])
    expect(() => createConnectionProviderRegistry([fixtureProvider, fixtureProvider])).toThrow(
      new ConnectionProviderError("duplicate_provider", "Connection provider fixture is registered more than once"),
    )
    expect(() => registry.validateDescriptors([fixtureDescriptor(), fixtureDescriptor()])).toThrow(
      expect.objectContaining({ code: "duplicate_connection" }),
    )
    expect(() => registry.validateDescriptor({ ...fixtureDescriptor(), providerKey: "missing" })).toThrow(
      expect.objectContaining({ code: "unknown_provider" }),
    )
    await expect(registry.resolve({
      descriptor: fixtureDescriptor({ enabled: false }),
      directory: "/workspace",
      context,
    })).rejects.toMatchObject({ code: "disabled_connection" })
    expect(() => registry.validateDescriptor({
      connectionId: "bad-acp",
      providerKey: "acp",
      configRevision: 1,
      enabled: true,
      config: { label: "Bad ACP", connection: { kind: "remote", url: "https://agent.example.test" } },
    })).toThrow(expect.objectContaining({ code: "invalid_config" }))
  })

  test("enforces immutable identity and monotonic config revisions", () => {
    const registry = createConnectionProviderRegistry([fixtureProvider])
    const previous = fixtureDescriptor()
    expect(() => registry.assertRevision(fixtureDescriptor({ connectionId: "retargeted" }), previous)).toThrow(
      expect.objectContaining({ code: "immutable_connection_identity" }),
    )
    expect(() => registry.assertRevision(fixtureDescriptor({ configRevision: 2 }), previous)).toThrow(
      expect.objectContaining({ code: "stale_config_revision" }),
    )
    expect(() => registry.assertRevision(fixtureDescriptor({ configRevision: 4 }), previous)).not.toThrow()
  })

  test("lets ACP labels rotate but rejects endpoint retargeting under one connection id", () => {
    const registry = createConnectionProviderRegistry([createAcpConnectionProvider()])
    const previous: HarnessConnectionDescriptor = {
      connectionId: "remote-acp",
      providerKey: "acp",
      configRevision: 1,
      enabled: true,
      config: { label: "Old label", connection: { kind: "streamable-http", url: "https://one.example.test/acp" } },
    }
    expect(() => registry.assertRevision({
      ...previous,
      configRevision: 2,
      config: { label: "New label", connection: { kind: "streamable-http", url: "https://one.example.test/acp" } },
    }, previous)).not.toThrow()
    expect(() => registry.assertRevision({
      ...previous,
      configRevision: 2,
      config: { label: "Old label", connection: { kind: "streamable-http", url: "https://two.example.test/acp" } },
    }, previous)).toThrow(expect.objectContaining({ code: "immutable_connection_identity" }))
  })

  test("resolves host-owned secret leases without exposing values or provider errors", async () => {
    const secret = "super-secret-token"
    const throwingProvider: ConnectionProvider<{ label: string }> = {
      ...fixtureProvider,
      providerKey: "throwing",
      resolve() {
        throw new Error(`endpoint rejected ${secret}`)
      },
    }
    const registry = createConnectionProviderRegistry([throwingProvider])
    const descriptor = fixtureDescriptor({
      providerKey: "throwing",
      secretRefs: { token: "credentials/agent-token" },
    })
    let failure: unknown
    try {
      await registry.resolve({
        descriptor,
        directory: "/workspace",
        context,
        secretLease: { secrets: { token: secret }, secretLeaseGeneration: "lease-2" },
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ code: "connection_unavailable" })
    expect(String(failure)).toBe("ConnectionProviderError: Connection fixture-primary is unavailable")
    expect(String(failure)).not.toContain(secret)
  })

  test("requires positive config revisions", () => {
    const registry = createConnectionProviderRegistry([fixtureProvider])
    expect(() => registry.validateDescriptor(fixtureDescriptor({ configRevision: 0 }))).toThrow(
      expect.objectContaining({ code: "invalid_descriptor" }),
    )
  })
})

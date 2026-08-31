import { describe, expect, test } from "vitest"
import type { HarnessConnectionDescriptor } from "@claxedo/agent-sdk-runtime"
import {
  ConnectionUnavailableError,
  createLocalConnectionSecretResolver,
  createVmConnectionSecretResolver,
  publicConnectionUnavailable,
} from "./connection-secrets"

function descriptor(overrides: Partial<HarnessConnectionDescriptor> = {}): HarnessConnectionDescriptor {
  return {
    connectionId: "conn-primary",
    providerKey: "fixture",
    configRevision: 7,
    enabled: true,
    config: { endpoint: "https://agent.example.test" },
    secretRefs: { token: "credentials/fixture-token" },
    ...overrides,
  }
}

describe("ConnectionSecretResolver", () => {
  test("local resolution returns the canonical secret lease and rotates its non-secret generation", async () => {
    let leaseGeneration = "local-1"
    let value = "secret-one"
    const resolver = createLocalConnectionSecretResolver({
      resolveReference: async (request) => ({
        value,
        leaseGeneration,
        expiresAt: 2_000,
        ...(request.reference ? {} : { revoked: true }),
      }),
      now: () => 1_000,
    })

    const first = await resolver({ descriptor: descriptor(), directory: "/repo" })
    expect(first).toEqual({
      secretLeaseGeneration: "token=local-1",
      secrets: { token: "secret-one" },
    })

    leaseGeneration = "local-2"
    value = "secret-two"
    const rotated = await resolver({ descriptor: descriptor(), directory: "/repo" })
    expect(rotated.secretLeaseGeneration).toBe("token=local-2")
    expect(rotated.secretLeaseGeneration).not.toContain("secret-two")
  })

  test("VM resolution derives trusted workspace scope from directory and rejects revocation", async () => {
    const calls: unknown[] = []
    let revoked = false
    const resolver = createVmConnectionSecretResolver({
      workspaceForDirectory: async (directory) => directory === "/repo"
        ? { workspaceId: "ws_1", runtimeId: "runtime_1" }
        : undefined,
      resolveLease: async (request) => {
        calls.push(request)
        return {
          secrets: { token: "vm-secret" },
          secretLeaseGeneration: "lease-42",
          expiresAt: 10_000,
          revoked,
        }
      },
      now: () => 1_000,
    })

    await expect(resolver({ descriptor: descriptor(), directory: "/repo" })).resolves.toEqual({
      secretLeaseGeneration: "lease-42",
      secrets: { token: "vm-secret" },
    })
    expect(calls).toEqual([{
      connectionId: "conn-primary",
      providerKey: "fixture",
      configRevision: 7,
      secretRefs: { token: "credentials/fixture-token" },
      workspace: { workspaceId: "ws_1", runtimeId: "runtime_1" },
    }])

    revoked = true
    await expect(resolver({ descriptor: descriptor(), directory: "/repo" }))
      .rejects.toMatchObject({ code: "connection_unavailable", reason: "revoked" })
    await expect(resolver({ descriptor: descriptor(), directory: "/missing" }))
      .rejects.toMatchObject({ code: "connection_unavailable", reason: "invalid_resolution" })
  })

  test("public unavailable errors are typed and redact resolver failures", async () => {
    const secret = "secret-that-must-not-leak"
    const resolver = createLocalConnectionSecretResolver({
      resolveReference: async () => {
        throw new Error(secret)
      },
    })

    let caught: unknown
    try {
      await resolver({ descriptor: descriptor(), directory: "/repo" })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ConnectionUnavailableError)
    if (!(caught instanceof ConnectionUnavailableError)) throw new Error("Expected typed unavailable error")
    const publicError = publicConnectionUnavailable(caught)
    expect(publicError).toEqual({
      code: "connection_unavailable",
      connectionId: "conn-primary",
      reason: "resolver_failed",
    })
    expect(JSON.stringify(publicError)).not.toContain(secret)
    expect(caught.message).not.toContain(secret)
  })

  test("disabled, expired, and incomplete leases fail closed", async () => {
    const local = createLocalConnectionSecretResolver({
      resolveReference: async () => ({ value: "secret", leaseGeneration: "1", expiresAt: 99 }),
      now: () => 100,
    })

    await expect(local({ descriptor: descriptor({ enabled: false }), directory: "/repo" }))
      .rejects.toMatchObject({ reason: "disabled" })
    await expect(local({ descriptor: descriptor(), directory: "/repo" }))
      .rejects.toMatchObject({ reason: "expired" })

    const missing = createLocalConnectionSecretResolver({
      resolveReference: async () => ({ leaseGeneration: "1" }),
    })
    await expect(missing({ descriptor: descriptor(), directory: "/repo" }))
      .rejects.toMatchObject({ reason: "missing_secret" })
  })
})

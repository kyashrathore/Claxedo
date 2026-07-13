import { describe, expect, it } from "vitest"
import type { ControlPlaneCredentials } from "../control-plane/services"
import { ActorIDSchema, ConnectionIDSchema, OwnerUserIDSchema, RequestIDSchema, type WorkGraphContext } from "@claxedo/workgraph/contracts"
import {
  HostedConnectionCredentialUnavailableError,
  HostedConnectionReconnectRequiredError,
  createHostedWorkGraphConnectionsPort,
} from "./hosted-connections"

describe("hosted WorkGraph Connections port", () => {
  it("opens the current org-partitioned secret only inside each callback", async () => {
    const secrets = ["first-secret", "rotated-secret"]
    const metadata = row()
    const port = createHostedWorkGraphConnectionsPort({
      resolveMetadata: async () => [metadata],
      credentials: () => credentials(() => secrets.shift() ?? null),
    })
    const [handle] = await port.resolveCapabilities(context(), {
      connectionIds: [metadata.id],
      capability: "work-source",
    })

    expect(JSON.stringify({ metadata, handle })).not.toContain("secret")
    expect(await handle!.withAuthorization(async (authorization) => authorization)).toEqual({
      token: "first-secret",
      tokenType: "bearer",
    })
    expect(await handle!.withAuthorization(async (authorization) => authorization.token)).toBe("rotated-secret")
    expect(JSON.stringify(handle)).not.toContain("rotated-secret")
  })

  it("preserves explicitly declared basic authorization", async () => {
    const metadata = row({ tokenType: "basic" })
    const port = createHostedWorkGraphConnectionsPort({
      resolveMetadata: async () => [metadata],
      credentials: () => credentials(() => "basic-secret"),
    })
    const [handle] = await port.resolveCapabilities(context(), {
      connectionIds: [metadata.id],
      capability: "work-source",
    })

    expect(await handle!.withAuthorization(async (authorization) => authorization)).toEqual({
      token: "basic-secret",
      tokenType: "basic",
    })
  })

  it("requires reconnect for legacy metadata without a token type before reading credentials", async () => {
    let reads = 0
    const metadata = row({ tokenType: undefined })
    const port = createHostedWorkGraphConnectionsPort({
      resolveMetadata: async () => [metadata],
      credentials: () => credentials(() => (reads++, "must-not-be-read")),
    })
    const [handle] = await port.resolveCapabilities(context(), {
      connectionIds: [metadata.id],
      capability: "work-source",
    })

    await expect(handle!.withAuthorization(async () => undefined)).rejects.toMatchObject({
      status: 409,
      code: "hosted_connection_reconnect_required",
    })
    await expect(handle!.withAuthorization(async () => undefined)).rejects.toBeInstanceOf(HostedConnectionReconnectRequiredError)
    expect(reads).toBe(0)
  })

  it.each(["degraded", "broken"] as const)("preserves an authorized %s Connection as reconnect-required", async (status) => {
    let reads = 0
    const metadata = row({ status })
    const port = createHostedWorkGraphConnectionsPort({
      resolveMetadata: async () => [metadata],
      credentials: () => credentials(() => (reads++, "must-not-be-read")),
    })
    const [handle] = await port.resolveCapabilities(context(), {
      connectionIds: [metadata.id],
      capability: "work-source",
    })

    await expect(handle!.withAuthorization(async () => undefined)).rejects.toMatchObject({
      status: 409,
      code: "hosted_connection_reconnect_required",
    })
    expect(reads).toBe(0)
  })

  it("fails closed for absent credentials and cross-owner metadata", async () => {
    let reads = 0
    const missing = createHostedWorkGraphConnectionsPort({
      resolveMetadata: async () => [row()],
      credentials: () => credentials(() => (reads++, null)),
    })
    const [handle] = await missing.resolveCapabilities(context(), {
      connectionIds: [ConnectionIDSchema.parse("connection")],
      capability: "work-source",
    })
    await expect(handle!.withAuthorization(async () => undefined)).rejects.toBeInstanceOf(HostedConnectionCredentialUnavailableError)

    const foreign = createHostedWorkGraphConnectionsPort({
      resolveMetadata: async () => [row({ ownerUserId: "mallory" })],
      credentials: () => credentials(() => (reads++, "foreign-secret")),
    })
    expect(await foreign.resolveCapabilities(context(), {
      connectionIds: [ConnectionIDSchema.parse("connection")],
      capability: "work-source",
    })).toEqual([])
    expect(reads).toBe(1)
  })
})

function context(): WorkGraphContext {
  return {
    ownerUserId: OwnerUserIDSchema.parse("alice"),
    actor: { type: "agent", id: ActorIDSchema.parse("attempt-agent") },
    requestId: RequestIDSchema.parse("request"),
    access: { mode: "owner" },
  }
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: ConnectionIDSchema.parse("connection"),
    ownerUserId: "alice",
    orgId: "org-acme",
    integrationId: "github" as const,
    capabilities: ["work-source"],
    status: "connected" as const,
    tokenType: "bearer" as const,
    ...overrides,
  }
}

function credentials(resolve: () => string | null): ControlPlaneCredentials {
  return {
    listCredentials: async () => [],
    getCredentialByProvider: async () => undefined,
    resolveCredentialSecret: async () => resolve(),
    putCredential: async () => { throw new Error("unused") },
    deleteCredential: async () => false,
    deleteCredentialsByProvider: async () => 0,
    updateCredentialStatus: async () => undefined,
    syncLocalCredentials: async () => ({ synced: [], existing: [], missing: [], failed: [] }),
  }
}

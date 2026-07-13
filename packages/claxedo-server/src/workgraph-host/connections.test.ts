import { describe, expect, it } from "vitest"
import type { ConnectionsService } from "@claxedo/connections"
import { ActorIDSchema, ConnectionIDSchema, OwnerUserIDSchema, RequestIDSchema, type WorkGraphContext } from "@claxedo/workgraph/contracts"
import { createWorkGraphConnectionsPort } from "./connections"

describe("WorkGraph Connections host adapter", () => {
  it("authorizes an exact team connection and resolves its token only inside live use", async () => {
    let tokenReads = 0
    const failures: string[] = []
    const service = {
      getById: async (id: string) => id === "connection-1" ? {
        id,
        integrationId: "github",
        owner: "org:acme",
        accountLabel: "Acme GitHub",
        grantedCapabilities: ["work-source"],
      } : undefined,
      getToken: async () => {
        tokenReads++
        return { ok: true, response: { token: "live-only", tokenType: "bearer" } }
      },
      reportAuthFailure: async (_id: string, reason: string) => { failures.push(reason) },
    } as unknown as ConnectionsService
    const port = createWorkGraphConnectionsPort({ service, resolveTeamOwner: () => "org:acme" })
    const [handle] = await port.resolveCapabilities(context(), {
      connectionIds: [ConnectionIDSchema.parse("connection-1")],
      capability: "work-source",
    })
    expect(tokenReads).toBe(0)
    expect(handle).toMatchObject({ integrationId: "github", scope: "team", accountLabel: "Acme GitHub" })
    expect(await handle!.withAuthorization(async (authorization) => authorization.tokenType)).toBe("bearer")
    expect(tokenReads).toBe(1)
    await handle!.reportAuthFailure("github_401")
    expect(failures).toEqual(["github_401"])
    expect(JSON.stringify(handle)).not.toContain("live-only")
  })

  it("refuses another organization's row before credential resolution", async () => {
    let tokenReads = 0
    const service = {
      getById: async () => ({ id: "connection-1", integrationId: "github", owner: "org:other", grantedCapabilities: ["work-source"] }),
      getToken: async () => (tokenReads++, { ok: true, response: { token: "foreign", tokenType: "bearer" } }),
    } as unknown as ConnectionsService
    const port = createWorkGraphConnectionsPort({ service, resolveTeamOwner: () => "org:acme" })
    expect(await port.resolveCapabilities(context(), {
      connectionIds: [ConnectionIDSchema.parse("connection-1")],
      capability: "work-source",
    })).toEqual([])
    expect(tokenReads).toBe(0)
  })
})

function context(): WorkGraphContext {
  return {
    ownerUserId: OwnerUserIDSchema.parse("alice"),
    actor: { type: "user", id: ActorIDSchema.parse("alice") },
    requestId: RequestIDSchema.parse("request"),
    access: { mode: "owner" },
  }
}

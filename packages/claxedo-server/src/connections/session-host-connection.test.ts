import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { decodeJwt } from "jose"
import { sessionHostId } from "@claxedo/workspace-relay-protocol"
import type { SandboxManager } from "@claxedo/sandbox-manager"
import type { ControlPlaneServices } from "../authority/services"
import { sandboxRelayTargetLookup } from "../authority/sandbox-relay-target"
import { WORKSPACE_ID, sessionHostPlane, type SessionHostPlane } from "../test-support/session-host-plane"
import { hostedSessionConnection, hostedSessionHostConnection } from "./hosted-connection-info"

let plane: SessionHostPlane
let services: ControlPlaneServices
const options = () => ({ runtimeAccessTokenSigner: plane.signRuntimeAccessToken, relayUrl: "https://relay.test" })
const ROOT = "ses_pi_connected"
const RESERVED = "ses_pi_reserved"

beforeAll(async () => {
  plane = await sessionHostPlane()
  const sandboxManager: Pick<SandboxManager, "target" | "ensure"> = {
    target: async () => ({ status: "unavailable", reason: "runtime_lease_not_ready" }),
    ensure: async () => ({ status: "provisioning", epoch: 1, retryAfterMs: 2_000, homeRegion: "us-east" }),
  }
  services = {
    authority: plane.store,
    sessionHosts: plane.store,
    sandbox: { sandboxManager },
    telemetry: { capture: () => {} },
    relay: {},
  } as unknown as ControlPlaneServices
  await plane.createHostedSession(ROOT)
  await plane.createVmSession("ses_vm")
  await plane.store.reserveSession(plane.owner, { operationId: "op_reserved", sessionId: RESERVED, workspaceId: WORKSPACE_ID, kind: "create", harnessId: "pi" })
})

afterAll(async () => {
  await plane.close()
})

function claims(connection: unknown) {
  const token = (connection as { connection: { runtimeAccessToken: string } }).connection.runtimeAccessToken
  return decodeJwt(token)
}

describe("connecting to a session served by its own host", () => {
  test("a session reserved in its own host is handed that host's session-scoped connection before it exists", async () => {
    const minted = await hostedSessionHostConnection(services, options(), plane.owner, { workspaceId: WORKSPACE_ID, sessionId: RESERVED })
    expect(minted).toMatchObject({ connection: { backing: "durable-object", hostId: sessionHostId(RESERVED), sessionId: RESERVED, relayUrl: "https://relay.test", role: "editor" } })
    const token = claims(minted)
    expect(token).toMatchObject({ host_id: sessionHostId(RESERVED), role: "editor", scope: "session", session_id: RESERVED, workspace_id: WORKSPACE_ID })
    expect(token.routing_id).toBeUndefined()
    expect(token.purpose).toBeUndefined()
    expect(await plane.store.runtimeAccessTokenActive({ jti: String(token.jti), workspaceId: WORKSPACE_ID, hostId: sessionHostId(RESERVED) })).toEqual({ active: true })
  })

  test("refuses a session the reservation placed in the workspace's runtime, an unreserved one, and a person who cannot create sessions", async () => {
    for (const sessionId of ["ses_vm", "ses_unreserved"]) {
      expect(await hostedSessionHostConnection(services, options(), plane.owner, { workspaceId: WORKSPACE_ID, sessionId }))
        .toMatchObject({ status: 409, error: { code: "session_host_unavailable" } })
    }
    await expect(hostedSessionHostConnection(services, options(), plane.member, { workspaceId: WORKSPACE_ID, sessionId: RESERVED }))
      .rejects.toMatchObject({ status: 403 })
  })

  test("a session's own connection is an editor's for whoever may send its turns and a viewer's otherwise", async () => {
    const owner = await hostedSessionConnection(services, options(), plane.owner, { workspaceId: WORKSPACE_ID, sessionId: ROOT })
    expect(owner).toMatchObject({ connection: { backing: "durable-object", hostId: sessionHostId(ROOT), sessionId: ROOT, role: "editor" } })
    expect(claims(owner)).toMatchObject({ scope: "session", session_id: ROOT, role: "editor", host_id: sessionHostId(ROOT) })
    expect(claims(owner).purpose).toBeUndefined()

    await expect(hostedSessionConnection(services, options(), plane.member, { workspaceId: WORKSPACE_ID, sessionId: ROOT })).rejects.toThrow()
    const memberId = plane.member.principal!.userId
    await plane.store.grantSessionShare!(plane.owner, { sessionId: ROOT, workspaceId: WORKSPACE_ID, grantedToUserId: memberId, level: "follow" })
    expect(await hostedSessionConnection(services, options(), plane.member, { workspaceId: WORKSPACE_ID, sessionId: ROOT }))
      .toMatchObject({ connection: { backing: "durable-object", role: "viewer" } })
    await expect(plane.store.recordRuntimeAccessToken(plane.member, {
      jti: "rat_follow_editor", workspaceId: WORKSPACE_ID, hostId: sessionHostId(ROOT), actorId: plane.member.principal!.actorId,
      actorKind: "human", role: "editor", sessionId: ROOT, expiresAt: Date.now() + 60_000,
    })).rejects.toThrow()
    await plane.store.grantSessionShare!(plane.owner, { sessionId: ROOT, workspaceId: WORKSPACE_ID, grantedToUserId: memberId, level: "send" })
    expect(await hostedSessionConnection(services, options(), plane.member, { workspaceId: WORKSPACE_ID, sessionId: ROOT }))
      .toMatchObject({ connection: { backing: "durable-object", role: "editor" } })
  })
})

describe("the relay resolving a session host", () => {
  test("admits a session its reservation or its row places there, and nothing else", async () => {
    const lookup = sandboxRelayTargetLookup({ sessionHosts: plane.store })
    const host = { found: true, baseUrl: "", backing: "durable-object" }
    expect(await lookup({ workspaceId: WORKSPACE_ID, hostId: sessionHostId(RESERVED) })).toEqual(host)
    expect(await lookup({ workspaceId: WORKSPACE_ID, hostId: sessionHostId(ROOT) })).toEqual(host)
    for (const sessionId of ["ses_unreserved", "ses_vm"]) {
      expect(await lookup({ workspaceId: WORKSPACE_ID, hostId: sessionHostId(sessionId) }))
        .toEqual({ found: false, code: "relay_resolver_workspace_target_unavailable" })
    }
    expect(await lookup({ workspaceId: "ws_missing", hostId: sessionHostId(ROOT) }))
      .toEqual({ found: false, code: "relay_resolver_workspace_not_found" })
    expect(await lookup({ workspaceId: WORKSPACE_ID, hostId: sessionHostId(ROOT), routingId: "route_1" }))
      .toEqual({ found: false, code: "runtime_access_token_invalid" })
  })

  test("never admits a deleted session's host again", async () => {
    const root = "ses_pi_deleted"
    await plane.createHostedSession(root)
    await plane.database.prepare("update sessions set deleted_at = ? where session_id = ?").bind(Date.now(), root).run()
    const lookup = sandboxRelayTargetLookup({ sessionHosts: plane.store })
    expect(await lookup({ workspaceId: WORKSPACE_ID, hostId: sessionHostId(root) }))
      .toEqual({ found: false, code: "relay_resolver_workspace_target_unavailable" })
  })
})

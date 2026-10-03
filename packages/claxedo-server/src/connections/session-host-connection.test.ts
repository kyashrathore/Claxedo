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
const pi = { id: "pi", access: "native" } as const

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
})

afterAll(async () => {
  await plane.close()
})

function claims(connection: unknown) {
  const token = (connection as { connection: { runtimeAccessToken: string } }).connection.runtimeAccessToken
  return decodeJwt(token)
}

describe("connecting to a session served by its own host", () => {
  test("the owner creating a Pi session on a cloud workspace is handed that session's host before it exists", async () => {
    const minted = await hostedSessionHostConnection(services, options(), plane.owner, { workspaceId: WORKSPACE_ID, sessionId: "ses_new", harness: pi })
    expect(minted).toMatchObject({ connection: { backing: "durable-object", hostId: sessionHostId("ses_new"), sessionId: "ses_new", relayUrl: "https://relay.test", role: "editor" } })
    const token = claims(minted)
    expect(token).toMatchObject({ host_id: sessionHostId("ses_new"), role: "editor", scope: "workspace", workspace_id: WORKSPACE_ID })
    expect(token.routing_id).toBeUndefined()
    expect(await plane.store.runtimeAccessTokenActive({ jti: String(token.jti), workspaceId: WORKSPACE_ID, hostId: sessionHostId("ses_new") })).toEqual({ active: true })
  })

  test("any other harness gets the workspace's own connection", async () => {
    const minted = await hostedSessionHostConnection(services, options(), plane.owner, { workspaceId: WORKSPACE_ID, sessionId: "ses_codex", harness: { id: "codex", access: "native" } })
    expect(minted).toMatchObject({ connection: { status: "provisioning", workspaceId: WORKSPACE_ID, retryAfterMs: 2_000 } })
  })

  test("refuses a session id already registered in the workspace's runtime, and a person who cannot create sessions there", async () => {
    await plane.store.reserveSession(plane.owner, { operationId: "op_vm", sessionId: "ses_vm", workspaceId: WORKSPACE_ID, kind: "create" })
    const vmProof = await plane.relayProof(plane.owner, { hostId: "host_vm", backing: "cloud-vm", jti: "rat_vm" })
    for (const action of ["start", "register"]) {
      const times = action === "register" ? { createdAt: Date.now(), updatedAt: Date.now() } : {}
      expect((await plane.post("/session-authorize", { action, sessionId: "ses_vm", operationId: "op_vm", ...times }, vmProof)).status).toBe(200)
    }
    expect(await hostedSessionHostConnection(services, options(), plane.owner, { workspaceId: WORKSPACE_ID, sessionId: "ses_vm", harness: pi }))
      .toMatchObject({ status: 409, error: { code: "session_host_unavailable" } })
    await expect(hostedSessionHostConnection(services, options(), plane.member, { workspaceId: WORKSPACE_ID, sessionId: "ses_member", harness: pi }))
      .rejects.toMatchObject({ status: 403 })
  })

  test("a session's own connection is an editor's for whoever may send its turns and a viewer's otherwise", async () => {
    const owner = await hostedSessionConnection(services, options(), plane.owner, { workspaceId: WORKSPACE_ID, sessionId: ROOT })
    expect(owner).toMatchObject({ connection: { backing: "durable-object", hostId: sessionHostId(ROOT), sessionId: ROOT, role: "editor" } })
    expect(claims(owner)).toMatchObject({ scope: "session", session_id: ROOT, role: "editor", host_id: sessionHostId(ROOT) })

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
  test("admits an unregistered session or its own root on a cloud workspace, and nothing else", async () => {
    const lookup = sandboxRelayTargetLookup({ sessionHosts: plane.store })
    const host = { found: true, baseUrl: "", backing: "durable-object" }
    expect(await lookup({ workspaceId: WORKSPACE_ID, hostId: sessionHostId("ses_unregistered") })).toEqual(host)
    expect(await lookup({ workspaceId: WORKSPACE_ID, hostId: sessionHostId(ROOT) })).toEqual(host)
    expect(await lookup({ workspaceId: WORKSPACE_ID, hostId: sessionHostId("ses_vm") }))
      .toEqual({ found: false, code: "relay_resolver_workspace_target_unavailable" })
    expect(await lookup({ workspaceId: "ws_missing", hostId: sessionHostId(ROOT) }))
      .toEqual({ found: false, code: "relay_resolver_workspace_not_found" })
    expect(await lookup({ workspaceId: WORKSPACE_ID, hostId: sessionHostId(ROOT), routingId: "route_1" }))
      .toEqual({ found: false, code: "runtime_access_token_invalid" })
  })
})

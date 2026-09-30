import type { D1Database } from "@cloudflare/workers-types"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { D1SessionAuthority } from "../authority/adapters/d1/session-authority"
import { D1WorkspaceAuthority } from "../authority/adapters/d1/workspace-authority"

export async function storedD1Session(database: D1Database) {
  const workspace = new D1WorkspaceAuthority(database, { deploymentId: "test", product: { kind: "claxedo-hosted" } })
  const identity = { adapter: "better-auth" as const, issuer: "https://auth.test", subject: "alice" }
  const admitted = await workspace.ensureApplicationIdentity(identity)
  if (admitted.state !== "active") throw new Error(admitted.state)
  const auth: SignedControlPlaneAuth = {
    mode: "signed", user: { subject: "alice", issuer: identity.issuer, tokenIdentifier: "alice" },
    principal: {
      userId: admitted.userId,
      actorId: admitted.actorId,
      actorKind: "human",
      deploymentId: "test",
      sessionId: "auth:alice",
      authenticatedAt: 1_800_000_000_000,
      methods: ["oauth:google"],
      assurance: "single-factor",
      client: {
        id: "claxedo-cli",
        kind: "cli",
        tokenKind: "access-token",
        resource: "https://core.test/control-plane",
        scopes: ["workspace:read"],
        deploymentId: "test",
        adapter: "better-auth",
        issuer: identity.issuer,
        tokenEndpointOrigin: identity.issuer,
        controlPlaneOrigin: "https://core.test",
      },
      identity,
    },
  }
  await workspace.createHostedOrganization(auth, { name: "Test", orgId: "org" })
  await workspace.createWorkspace(auth, { workspaceId: "ws", orgId: "org", displayName: "Test", backing: "cloud-vm" })
  const sessions = new D1SessionAuthority(database, { deploymentId: "test" })
  await sessions.reserveSession(auth, { operationId: "op", sessionId: "ses", workspaceId: "ws", kind: "create" })
  await sessions.registerRuntimeSession({ principalKind: "user", actorId: admitted.actorId, actorKind: "human", operationId: "op", sessionId: "ses", workspaceId: "ws", createdAt: 1, updatedAt: 1 })
  return { auth, sessions }
}

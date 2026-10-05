import type { D1Database } from "@cloudflare/workers-types"
import { D1SessionAuthority } from "../authority/adapters/d1/session-authority"
import { D1WorkspaceAuthority } from "../authority/adapters/d1/workspace-authority"
import { D1ApplicationIdentityAuthority } from "../authority/adapters/d1/application-identity"
import { signedD1Identity } from "./signed-d1-identity"

export async function storedD1Session(database: D1Database) {
  const product = { kind: "claxedo-hosted" } as const
  const workspace = new D1WorkspaceAuthority(database, { deploymentId: "test", product })
  const auth = await signedD1Identity(new D1ApplicationIdentityAuthority(workspace.accessContext(), product), "alice")
  await workspace.createHostedOrganization(auth, { name: "Test", orgId: "org" })
  await workspace.createWorkspace(auth, { workspaceId: "ws", orgId: "org", displayName: "Test", backing: "cloud-vm" })
  const sessions = new D1SessionAuthority(database, { deploymentId: "test" })
  await sessions.reserveSession(auth, { operationId: "op", sessionId: "ses", workspaceId: "ws", kind: "create" })
  await sessions.registerRuntimeSession({ principalKind: "user", actorId: auth.principal!.actorId, actorKind: "human", operationId: "op", sessionId: "ses", workspaceId: "ws", createdAt: 1, updatedAt: 1 })
  return { auth, sessions }
}

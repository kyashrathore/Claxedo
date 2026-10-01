import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { localOnlyAuthAdapter, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { createSqliteWorkspaceAuthority } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority"
import { createSqliteCentralStore } from "../authority/adapters/sqlite/central-store"
import { createControlPlaneServices } from "../authority/services"
import { ControlPlaneProtocolError } from "../authority/http/protocol"
import { pulledCloudWorkspace } from "../authority/pulled-session"
import { removeTestDataDir } from "./test-data-dir"

export type RuntimeSnapshot = {
  messages: Array<{ info: { id: string; role: "assistant" }; parts: Array<Record<string, unknown>> }>
  maxEventOrdinal: number
}

export type RuntimeSession = { title: string; updated: number }

/**
 * The self-hosted composition's real session stores — the SQLite projection
 * and the SQLite authority — holding one registered cloud session, and a
 * runtime whose snapshot and session a test sets before each pull. The
 * projection's database outlives one call, so each call names its own session.
 */
export async function selfHostedSessionStores() {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "claxedo-session-stores-"))
  const authority = createSqliteWorkspaceAuthority({ path: path.join(root, "authority.sqlite") })
  const central = createSqliteCentralStore({ mode: () => "workspace_replicated" })
  const services = createControlPlaneServices(
    { projectionStore: central.projectionStore, durableSessionLog: central.durableSessionLog },
    { authority, auth: localOnlyAuthAdapter() },
  )
  const auth: SignedControlPlaneAuth = {
    mode: "signed",
    token: "tok_alice",
    user: { subject: "alice", tokenIdentifier: "https://idp.example.test|alice", issuer: "https://idp.example.test" },
  }
  const suffix = path.basename(root).slice(-6)
  const workspaceId = `ws_${suffix}`
  const sessionId = `ses_${suffix}`
  await authority.usersMe(auth)
  const org = await authority.createOrg!(auth, { name: "Stores" }) as { org_id: string }
  await authority.createCloudWorkspace(auth, { workspaceId, displayName: "Stores", orgId: org.org_id })
  await authority.reserveSession(auth, { operationId: "op_stores", sessionId, workspaceId, kind: "create" })
  await authority.registerRuntimeSession({
    principalKind: "user",
    actorId: auth.user.tokenIdentifier,
    actorKind: "human",
    operationId: "op_stores",
    sessionId,
    workspaceId,
    createdAt: 1,
    updatedAt: 1,
  })

  const runtime: { snapshot: RuntimeSnapshot; session: RuntimeSession } = {
    snapshot: { messages: [], maxEventOrdinal: 0 },
    session: { title: "Untitled", updated: 1 },
  }
  const sessionBody = () => ({ id: sessionId, title: runtime.session.title, time: { created: 1, updated: runtime.session.updated } })
  const runtimeFetch = async (input: { path: string }) => {
    if (input.path === "/global/health") return Response.json({ workspaceId })
    if (input.path === `/session/${sessionId}/message?snapshot=1`) return Response.json({ ...runtime.snapshot, session: sessionBody() })
    if (input.path === `/session/${sessionId}`) return Response.json(sessionBody())
    if (input.path === "/session/status") return Response.json({})
    return new Response("not found", { status: 404 })
  }

  const opened = await authority.openWorkspace(auth, { workspaceId })

  return {
    services,
    authority,
    auth,
    workspaceId,
    sessionId,
    projectionWorkspace: pulledCloudWorkspace(workspaceId, opened.workspace, ControlPlaneProtocolError),
    runtime,
    options: { runtimeFetch },
    /** The projection keys messages by id alone, so each session's ids carry its suffix. */
    messageId: (name: string) => `${name}_${suffix}`,
    assistantMessage: (name: string) => ({ info: { id: `${name}_${suffix}`, role: "assistant" as const }, parts: [{ type: "text", text: name }] }),
    dispose: () => removeTestDataDir(root),
  }
}

import { CLAXEDO_MCP_PATH, CLAXEDO_MCP_SERVER_INFO, type RuntimeCredentialClaims } from "@claxedo/mcp"
import type { ClaxedoFetch } from "@claxedo/mcp/client"
import type { McpCredential } from "@claxedo/mcp/context"
import type { TurnDelivery } from "@claxedo/harness/contract"
import { sessionHostId } from "@claxedo/workspace-relay-protocol"
import type { WorkspaceOwnerIdentity } from "@claxedo/server-core/platform/auth/authority"
import { mintSessionMcpToken, verifySessionMcpToken } from "@claxedo/server-core/platform/auth/runtime-access-token"
import { sessionHostMachineAccess, sessionHostOwnAccess, type SessionHostMachineAccess, type SessionHostMachineDeps } from "../authority/session-host-machine-access"
import { sessionHostAdmits } from "../authority/session-hosts"

const MACHINE_TOKEN_TTL_SECONDS = 15 * 60
const MACHINE_TOKEN_RENEW_MS = 60_000

export type SessionMcpCredentialsInput = SessionHostMachineDeps & {
  env: NodeJS.ProcessEnv
  resolveWorkspaceOwner(workspaceId: string): Promise<WorkspaceOwnerIdentity | undefined>
  /** The first-party tool groups the workspace's project consented to, read as its owner. */
  toolGroups(owner: WorkspaceOwnerIdentity, workspaceId: string): Promise<readonly string[]>
}

type RuntimeCredential = Extract<McpCredential, { kind: "runtime" }>

/**
 * The first-party MCP credential of a session served by its own host.
 *
 * Issued with each turn's delivery, only for the workspace owner's own session
 * and only while the project has a first-party tool group on: a bearer bound
 * to (owner, session, workspace), expiring with the turn and at most ten
 * minutes out, under an audience only the MCP endpoint verifies. Every request
 * re-reads the session, so a deleted session, a session moved off its host or a
 * workspace with another owner is refused whatever the token says. The tools
 * reach the session's own workspace and nothing else: the client is given no
 * control plane, the session's own routes at its own host, since the machine
 * does not hold that session, and every other route on the machine, each
 * through an owner's editor token for that one host, recorded only for a live
 * session. The endpoint answers each of these requests on its own, so each
 * token is held per session and host for this isolate and minted again a
 * minute before it expires.
 */
export function sessionMcpCredentials(input: SessionMcpCredentialsInput) {
  const ownedSession = async (workspaceId: string, sessionId: string): Promise<WorkspaceOwnerIdentity | undefined> => {
    const [owner, placement] = await Promise.all([
      input.resolveWorkspaceOwner(workspaceId),
      input.sessionHosts.readSessionHostPlacement({ workspaceId, sessionId }),
    ])
    if (!owner || !placement?.session || !sessionHostAdmits(placement, { workspaceId, sessionId })) return undefined
    return (placement.session.creatorUserId ?? owner.userId) === owner.userId ? owner : undefined
  }

  const access = async (credential: RuntimeCredential, host: "machine" | "session"): Promise<SessionHostMachineAccess> => {
    const { workspaceId, sessionId, userId } = credential
    const owner = sessionId ? await ownedSession(workspaceId, sessionId) : undefined
    if (!owner || !sessionId || owner.userId !== userId) throw new Error(`Session ${sessionId ?? "(none)"} no longer reaches workspace ${workspaceId}`)
    const grant = { actorId: owner.actorId, orgId: owner.orgId, workspaceId, sessionId, ttlSeconds: MACHINE_TOKEN_TTL_SECONDS }
    return host === "session" ? await sessionHostOwnAccess(input, grant) : await sessionHostMachineAccess(input, { scope: "session-mcp", ...grant })
  }

  const held = new Map<string, { access: Promise<SessionHostMachineAccess>; expiresAt: number }>()

  const relayFetch = (credential: RuntimeCredential, host: "machine" | "session"): ClaxedoFetch => {
    const key = JSON.stringify([host, credential.workspaceId, credential.sessionId, credential.userId])
    const current = async () => {
      const live = await held.get(key)?.access
      if (live && live.expiresAt - Date.now() > MACHINE_TOKEN_RENEW_MS) return live
      for (const [other, entry] of held) if (entry.expiresAt <= Date.now()) held.delete(other)
      const entry = { access: access(credential, host), expiresAt: Date.now() + MACHINE_TOKEN_TTL_SECONDS * 1000 }
      held.set(key, entry)
      entry.access.catch(() => { if (held.get(key) === entry) held.delete(key) })
      return await entry.access
    }
    return async (path, init) => {
      const { relayUrl, runtimeAccessToken } = await current()
      const headers = new Headers(init?.headers)
      headers.set("Authorization", `Bearer ${runtimeAccessToken}`)
      return await fetch(`${relayUrl}/workspaces/${encodeURIComponent(credential.workspaceId)}${path}`, {
        ...init, headers, redirect: init?.redirect ?? "manual",
      })
    }
  }

  return {
    async issue(request: {
      origin: string
      owner: WorkspaceOwnerIdentity
      workspaceId: string
      sessionId: string
      expiresAt: number
    }): Promise<TurnDelivery["firstPartyMcp"]> {
      const { owner, workspaceId, sessionId } = request
      if ((await input.toolGroups(owner, workspaceId)).length === 0) return undefined
      const { token } = await mintSessionMcpToken({ userId: owner.userId, orgId: owner.orgId, workspaceId, sessionId, expiresAt: request.expiresAt }, input.env)
      const url = new URL(CLAXEDO_MCP_PATH, request.origin)
      url.searchParams.set("session", sessionId)
      return { name: CLAXEDO_MCP_SERVER_INFO.name, url: url.href, token }
    },

    async verify(token: string): Promise<RuntimeCredentialClaims | undefined> {
      let claims: Awaited<ReturnType<typeof verifySessionMcpToken>>
      try {
        claims = await verifySessionMcpToken(token, input.env)
      } catch {
        return undefined
      }
      const owner = await ownedSession(claims.workspaceId, claims.sessionId)
      if (!owner || owner.userId !== claims.userId || owner.orgId !== claims.orgId) return undefined
      return {
        runtimeId: sessionHostId(claims.sessionId),
        workspaceId: claims.workspaceId,
        sessionId: claims.sessionId,
        userId: claims.userId,
        expiresAt: claims.expiresAt,
      }
    },

    async toolGroups(credential: RuntimeCredential): Promise<readonly string[]> {
      const owner = await input.resolveWorkspaceOwner(credential.workspaceId)
      return owner && owner.userId === credential.userId ? await input.toolGroups(owner, credential.workspaceId) : []
    },

    workspaceFetch(credential: RuntimeCredential): ClaxedoFetch {
      return relayFetch(credential, "machine")
    },

    sessionHostFetch(credential: RuntimeCredential): ClaxedoFetch {
      return relayFetch(credential, "session")
    },
  }
}

export type SessionMcpCredentials = ReturnType<typeof sessionMcpCredentials>

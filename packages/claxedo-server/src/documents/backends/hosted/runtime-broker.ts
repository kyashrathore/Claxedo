import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../../../authority/services"
import { mintDocumentRelayJobToken, mintDocumentSessionToken } from "@claxedo/server-core/platform/auth/runtime-access-token"
import { defaultHomeRegion, normalizeClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"
import type { DocumentIndexEntry } from "@claxedo/server-core/documents/index-store"
import type { DocumentRead } from "@claxedo/server-core/documents/port"
import { fetchRelayResponse, parseRelayJson, type RelayHttpOptions } from "../../relay-http"
import { resolveRuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"
import { asRecord } from "@claxedo/server-core/platform/json/index"
import { trimToUndefined } from "@claxedo/helpers/string"

export function createHostedDocumentRuntimeBroker(
  services: ControlPlaneServices,
  env: NodeJS.ProcessEnv,
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
  options: RelayHttpOptions = {},
) {
  return {
    async open(input: {
      entry: DocumentIndexEntry
      sessionId: string
      auth: SignedControlPlaneAuth
      origin: string
      read: DocumentRead
      jobExpiresAt?: number
      registerCapability?: (input: { jti: string; jobExpiresAt: number }) => Promise<void>
      signal?: AbortSignal
    }) {
      const authority = services.authority
      if (!authority?.resolveSession) throw new Error("Session placement resolution is unavailable")
      const workspaceId = workspaceIdFrom(await authority.resolveSession(input.auth, { sessionId: input.sessionId }))
      if (!workspaceId) throw new Error("Session has no reachable workspace placement")
      await authority.authorizeSessionRead(input.auth, { sessionId: input.sessionId, workspaceId })
      const opened = await authority.openWorkspace(input.auth, { workspaceId })
      const orgId = trimToUndefined(opened.workspace?.org_id)
      if (!orgId || orgId !== input.entry.org_id)
        throw new Error("Session workspace organization does not match document scope")
      const workspaceProjectId = trimToUndefined(opened.workspace?.project_id)
      if (workspaceProjectId !== input.entry.project_id) {
        throw new Error("Session workspace project does not match document scope")
      }
      if (!["editor", "admin", "owner"].includes(opened.role ?? "")) {
        throw new Error("Session workspace write access is denied")
      }
      const manager = services.sandbox.sandboxManager
      const provider = services.relay.provider
      if (!manager || !provider) throw new Error("Session runtime transport is unavailable")
      const target = await manager.target(workspaceId).catch(() => undefined)
      if (target?.status !== "ready") throw new Error("Session runtime is unreachable")
      const access = await provider.mintRuntimeAccessToken({
        workspaceId,
        hostId: target.hostId,
        principalKind: "user",
        ...await resolveRuntimeActor(authority, input.auth),
        orgId,
        role: "editor",
        ttlMs: 5 * 60_000,
      })
      const relay = await provider.getRelayEndpoint(
        workspaceId,
        normalizeClaxedoRegion(target.homeRegion, services.defaultHomeRegion ?? defaultHomeRegion()),
      )
      const jobExpiresAt = input.jobExpiresAt ?? Math.floor(Date.now() / 1000) + 60 * 60
      const capability = await mintDocumentSessionToken(
        {
          orgId,
          projectId: input.entry.project_id,
          workspaceId,
          sessionId: input.sessionId,
          documentId: input.entry.id,
          jobExpiresAt,
        },
        env,
      )
      const job = await mintDocumentRelayJobToken(
        {
          userId: input.auth.user.subject,
          orgId,
          projectId: input.entry.project_id,
          localWorkspaceId: workspaceId,
          cloudWorkspaceId: workspaceId,
          sessionId: input.sessionId,
          documentId: input.entry.id,
          operations: ["hydrate", "write", "resolve"],
          jobExpiresAt,
        },
        env,
      )
      const controlPlaneUrl = configuredControlPlaneUrl(env)
      const documentJob = {
        token: job.token,
        userId: input.auth.user.subject,
        orgId,
        projectId: input.entry.project_id,
        localWorkspaceId: workspaceId,
        cloudWorkspaceId: workspaceId,
      }
      const response = await fetchRelayResponse(fetcher,
        `${relay.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(workspaceId)}/api/wr/documents/hydrate`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${access.token}`,
            "content-type": "application/json",
            "x-claxedo-directory": `workspace:${workspaceId}`,
          },
          body: JSON.stringify({
            sessionId: input.sessionId,
            documentId: input.entry.id,
            displayName: input.entry.display_name,
            markdown: input.read.markdown,
            baseVersion: input.read.version,
            writeback: {
              url: `${controlPlaneUrl}/documents/${encodeURIComponent(input.entry.id)}/runtime-writeback?org_id=${encodeURIComponent(orgId)}&project_id=${encodeURIComponent(input.entry.project_id)}&workspace_id=${encodeURIComponent(workspaceId)}&session_id=${encodeURIComponent(input.sessionId)}`,
              renewUrl: `${controlPlaneUrl}/documents/${encodeURIComponent(input.entry.id)}/runtime-capability/renew?org_id=${encodeURIComponent(orgId)}&project_id=${encodeURIComponent(input.entry.project_id)}&workspace_id=${encodeURIComponent(workspaceId)}&session_id=${encodeURIComponent(input.sessionId)}`,
              token: capability.token,
              expiresAt: capability.expiresAt,
            },
            job: documentJob,
          }),
          signal: input.signal,
        },
        options,
      )
      if (!response.response.ok) throw new Error(`Session runtime hydration failed: ${response.response.status}`)
      const hydratedPath = asRecord(parseRelayJson(response.body, "Session runtime hydration"))?.path
      if (typeof hydratedPath !== "string" || !hydratedPath)
        throw new Error("Session runtime hydration response is invalid")
      await input.registerCapability?.({
        jti: capability.jti,
        jobExpiresAt,
      })
      if (input.registerCapability) {
        const activation = await fetchRelayResponse(fetcher,
          `${relay.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(workspaceId)}/api/wr/documents/${encodeURIComponent(input.sessionId)}/${encodeURIComponent(input.entry.id)}/activate`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${access.token}`,
              "content-type": "application/json",
              "x-claxedo-directory": `workspace:${workspaceId}`,
            },
            body: "{}",
            signal: input.signal,
          },
          options,
        )
        if (!activation.response.ok) {
          throw new Error(`Session runtime document activation failed: ${activation.response.status}`)
        }
        const activated = asRecord(parseRelayJson(activation.body, "Session runtime document activation"))
        if (activated?.path !== hydratedPath) {
          throw new Error("Session runtime document activation response is invalid")
        }
      }
      return { path: hydratedPath }
    },
    async resolve(input: {
      entry: DocumentIndexEntry
      sessionId: string
      auth: SignedControlPlaneAuth
      localWorkspaceId: string
      cloudWorkspaceId: string
      choice: "durable" | "draft"
      current: DocumentRead
      jobExpiresAt: number
      writeback: { token: string; expiresAt: number }
      signal?: AbortSignal
    }) {
      const authority = services.authority
      const provider = services.relay.provider
      if (!authority?.resolveSession || !provider) throw new Error("Session runtime transport is unavailable")
      const workspaceId = workspaceIdFrom(await authority.resolveSession(input.auth, { sessionId: input.sessionId }))
      if (!workspaceId || workspaceId !== input.cloudWorkspaceId) throw new Error("Session placement changed")
      await authority.authorizeSessionRead(input.auth, { sessionId: input.sessionId, workspaceId })
      const opened = await authority.openWorkspace(input.auth, { workspaceId })
      if (
        opened.workspace?.org_id !== input.entry.org_id ||
        opened.workspace.project_id !== input.entry.project_id ||
        !["editor", "admin", "owner"].includes(opened.role ?? "")
      ) {
        throw new Error("Session workspace write access is denied")
      }
      const target = await services.sandbox.sandboxManager?.target(workspaceId).catch(() => undefined)
      if (target?.status !== "ready") throw new Error("Session runtime is unreachable")
      const access = await provider.mintRuntimeAccessToken({
        workspaceId,
        hostId: target.hostId,
        principalKind: "user",
        ...await resolveRuntimeActor(authority, input.auth),
        orgId: input.entry.org_id,
        role: "editor",
        ttlMs: 5 * 60_000,
      })
      const capability = await mintDocumentRelayJobToken(
        {
          userId: input.auth.user.subject,
          orgId: input.entry.org_id,
          projectId: input.entry.project_id,
          localWorkspaceId: input.localWorkspaceId,
          cloudWorkspaceId: input.cloudWorkspaceId,
          sessionId: input.sessionId,
          documentId: input.entry.id,
          operations: ["resolve"],
          jobExpiresAt: input.jobExpiresAt,
        },
        env,
      )
      const relay = await provider.getRelayEndpoint(
        workspaceId,
        normalizeClaxedoRegion(target.homeRegion, services.defaultHomeRegion ?? defaultHomeRegion()),
      )
      const response = await fetchRelayResponse(fetcher,
        `${relay.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(workspaceId)}/api/wr/documents/${encodeURIComponent(input.sessionId)}/${encodeURIComponent(input.entry.id)}/resolve`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${access.token}`,
            "content-type": "application/json",
            "x-claxedo-directory": `workspace:${workspaceId}`,
          },
          body: JSON.stringify({
            strategy: input.choice === "durable" ? "use-remote" : "keep-session",
            remoteVersion: input.current.version,
            ...(input.choice === "durable" ? { remoteMarkdown: input.current.markdown } : {}),
            writeback: {
              url: `${configuredControlPlaneUrl(env)}/documents/${encodeURIComponent(input.entry.id)}/runtime-writeback?org_id=${encodeURIComponent(input.entry.org_id)}&project_id=${encodeURIComponent(input.entry.project_id)}&workspace_id=${encodeURIComponent(workspaceId)}&session_id=${encodeURIComponent(input.sessionId)}`,
              renewUrl: `${configuredControlPlaneUrl(env)}/documents/${encodeURIComponent(input.entry.id)}/runtime-capability/renew?org_id=${encodeURIComponent(input.entry.org_id)}&project_id=${encodeURIComponent(input.entry.project_id)}&workspace_id=${encodeURIComponent(workspaceId)}&session_id=${encodeURIComponent(input.sessionId)}`,
              token: input.writeback.token,
              expiresAt: input.writeback.expiresAt,
            },
            job: {
              token: capability.token,
              userId: input.auth.user.subject,
              orgId: input.entry.org_id,
              projectId: input.entry.project_id,
              localWorkspaceId: input.localWorkspaceId,
              cloudWorkspaceId: input.cloudWorkspaceId,
            },
          }),
          signal: input.signal,
        },
        options,
      )
      if (!response.response.ok)
        throw new Error(`Session document conflict resolution failed: ${response.response.status}`)
      const result = asRecord(parseRelayJson(response.body, "Session document conflict resolution"))
      const path = result?.path
      const preserved = result?.preserved
      if (
        typeof path !== "string" || !path ||
        (result !== undefined && "preserved" in result && typeof preserved !== "string")
      ) {
        throw new Error("Session document conflict resolution response is invalid")
      }
      return {
        path,
        ...(typeof preserved === "string" ? { preserved } : {}),
        version: input.current.version,
      }
    },
  }
}

function workspaceIdFrom(value: unknown) {
  const record = asRecord(value)
  if (!record) return undefined
  return (
    trimToUndefined(record.workspace_id) ??
    trimToUndefined(record.workspaceId) ??
    trimToUndefined(asRecord(record.workspace)?.workspace_id)
  )
}

function configuredControlPlaneUrl(env: NodeJS.ProcessEnv) {
  const value = trimToUndefined(env.CLAXEDO_PUBLIC_URL) ?? trimToUndefined(env.CLAXEDO_CONTROL_PLANE_URL)
  if (!value) throw new Error("Document write-back requires a configured Control Plane URL")
  const url = new URL(value)
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("Document write-back Control Plane URL must use HTTPS")
  }
  return url.origin
}

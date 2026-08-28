import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { mintDocumentRelayJobToken } from "@claxedo/server-core/platform/auth/runtime-access-token"
import type { ControlPlaneServices } from "../../../authority/services"
import { defaultHomeRegion } from "@claxedo/server-core/platform/runtime/region/index"
import { DocumentVersionConflictError } from "../../errors"
import type { DocumentVersion } from "../../port"
import { fetchRelayResponse, parseRelayJson, relayResponseText, type RelayHttpOptions } from "../../relay-http"
import { resolveRuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"

export function createHostedLocalDocumentRelay(
  services: ControlPlaneServices,
  env: NodeJS.ProcessEnv,
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
  options: RelayHttpOptions = {},
) {
  return {
    async request(input: {
      auth: SignedControlPlaneAuth
      orgId: string
      projectId: string
      localWorkspaceId: string
      cloudWorkspaceId: string
      sessionId: string
      documentId: string
      operation: "list" | "read" | "write" | "resolve"
      markdown?: string
      expectedVersion?: string
      jobExpiresAt: number
      signal?: AbortSignal
    }) {
      const authority = services.authority
      const provider = services.relay.provider
      if (!authority || !provider) throw new Error("Local document relay is unavailable")
      const opened = await authority.openWorkspace(input.auth, { workspaceId: input.localWorkspaceId })
      if (opened.workspace?.org_id !== input.orgId || opened.workspace.project_id !== input.projectId ||
        opened.workspace.access !== "user-hosted" || opened.workspace.backing !== "local-worktree") {
        throw new Error("Local document workspace scope is invalid")
      }
      const write = input.operation === "write" || input.operation === "resolve"
      if (write && !["editor", "admin", "owner"].includes(opened.role ?? "")) {
        throw new Error("Local document workspace write access is denied")
      }
      const link = await authority.activeLocalHostLink(input.auth, { workspaceId: input.localWorkspaceId })
      if (!link.active) throw new Error("Local document installation is unreachable")
      const token = await provider.mintRuntimeAccessToken({
        workspaceId: input.localWorkspaceId,
        hostId: link.host_id,
        subject: input.auth.user.subject,
        principalKind: "user",
        ...await resolveRuntimeActor(authority, input.auth),
        orgId: input.orgId,
        role: write ? "editor" : "viewer",
        ttlMs: 5 * 60_000,
      })
      const capability = await mintDocumentRelayJobToken({
        userId: input.auth.user.subject,
        orgId: input.orgId,
        projectId: input.projectId,
        localWorkspaceId: input.localWorkspaceId,
        cloudWorkspaceId: input.cloudWorkspaceId,
        sessionId: input.sessionId,
        documentId: input.documentId,
        operations: [input.operation === "list" ? "resolve" : input.operation],
        jobExpiresAt: input.jobExpiresAt,
      }, env)
      const relay = await provider.getRelayEndpoint(input.localWorkspaceId, services.defaultHomeRegion ?? defaultHomeRegion())
      const body = {
        userId: input.auth.user.subject,
        orgId: input.orgId,
        projectId: input.projectId,
        localWorkspaceId: input.localWorkspaceId,
        cloudWorkspaceId: input.cloudWorkspaceId,
        sessionId: input.sessionId,
        documentId: input.documentId,
        operation: input.operation,
        ...(input.markdown !== undefined ? { markdown: input.markdown } : {}),
        ...(input.expectedVersion ? { expectedVersion: input.expectedVersion } : {}),
      }
      const read = input.operation === "list" || input.operation === "read"
      const endpoint = `${relay.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(input.localWorkspaceId)}/api/wr/local-documents/broker`
      const result = await fetchRelayResponse(fetcher,
        read ? `${endpoint}?input=${encodeURIComponent(JSON.stringify(body))}` : endpoint,
        {
          method: read ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${token.token}`,
            "content-type": "application/json",
            "x-claxedo-document-capability": capability.token,
            "x-opencode-directory": `workspace:${input.localWorkspaceId}`,
          },
          ...(read ? {} : { body: JSON.stringify(body) }),
          signal: input.signal,
        },
        options,
      )
      if (result.response.status === 409) {
        const value = parseRelayJson(result.body, "Local document conflict")
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("Local document conflict response is invalid")
        }
        throw new DocumentVersionConflictError(
          typeof (value as Record<string, unknown>).currentVersion === "string"
            ? (value as Record<string, unknown>).currentVersion as DocumentVersion
            : null,
        )
      }
      if (!result.response.ok) {
        throw new Error(`Local document broker failed: ${result.response.status} ${relayResponseText(result.body).slice(0, 4_096)}`)
      }
      const value = parseRelayJson(result.body, "Local document broker")
      if (input.operation === "list" && !Array.isArray(value)) {
        throw new Error("Local document index response is invalid")
      }
      if (input.operation !== "list" && (!value || typeof value !== "object" || Array.isArray(value))) {
        throw new Error("Local document broker response is invalid")
      }
      return value
    },
  }
}

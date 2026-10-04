import type { Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import { routeParam } from "@claxedo/helpers/route-param"
import { z } from "zod"
import {
  ControlPlaneAuthError,
  controlPlaneAuthErrorBody,
} from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import { isClaxedoError } from "@claxedo/server-core/platform/errors/base"
import type { ControlPlaneServices } from "../authority/services"
import type { ConnectionRateLimiter } from "../platform/auth/rate-limit"
import { contentfulStatus } from "../platform/http/status"
import {
  apiError,
  captureWorkspaceTelemetry,
  missingBearerBody,
  parsedBody,
  signedOrError,
  type WorkspaceRouteOptions,
} from "./route-support"
import { controlPlaneRateLimitError } from "./runtime-token-guards"

/**
 * The owner's `/api/workspace/:id/host-assignment` verbs against an enrolled
 * machine. No machine signature is checked here: liveness is the enrollment
 * lease and consent is the machine's heartbeat-acked served set. The answer
 * carries no tunnel credential; the machine receives its fenced one in the
 * answer to the heartbeat that acks this assignment.
 */

/** Names, ids and a repository URL — the control-plane JSON bound. */
const ASSIGN_BODY_LIMIT_BYTES = 16 * 1024

const assignBodyLimit = bodyLimit({
  maxSize: ASSIGN_BODY_LIMIT_BYTES,
  onError: (c) =>
    c.json(
      { error: apiError("request_body_too_large", `Request body exceeds the ${ASSIGN_BODY_LIMIT_BYTES}-byte limit`) },
      413,
    ),
})

const assignBody = z
  .object({
    hostId: z.string(),
    displayName: z.string().optional(),
    orgId: z.string().optional(),
    projectId: z.string().optional(),
    repoUrl: z.string().optional(),
    repoName: z.string().optional(),
    gitBranch: z.string().optional(),
    remoteDirectory: z.string().optional(),
  })
  .strict()

function isWorkspaceBackingConflict(err: unknown) {
  return isClaxedoError(err) && err.code === "workspace_backing_conflict"
}

function workspaceBackingConflictBody() {
  return {
    error: apiError(
      "workspace_backing_conflict",
      "Workspace is provisioned in the cloud and cannot be placed on a machine",
    ),
  }
}

export type HostAssignmentHandlers = {
  assign: (c: Context) => Promise<Response>
  unassign: (c: Context) => Promise<Response>
}

export function hostAssignmentHandlers(
  services: ControlPlaneServices | undefined,
  options: WorkspaceRouteOptions,
  controlPlaneRateLimiter: ConnectionRateLimiter,
): HostAssignmentHandlers {
  const authOptions = { ...options, requireSigned: true as const }
  return {
    assign: async (c) => {
      const workspaceId = routeParam(c, "id")
      const authResult = await signedOrError(c.req.raw, authOptions, services)
      if ("error" in authResult) return c.json(authResult.error, authResult.status)
      const auth = authResult.auth
      if (!auth) return c.json(missingBearerBody(), 401)
      // `bodyUsed` means the mounting router already ran the body through its
      // own bound (`workspace/routes/index.ts` reads `hostId` before dispatch);
      // re-reading a consumed stream is an error, not a second parse.
      const tooLarge = c.req.raw.bodyUsed ? undefined : await assignBodyLimit(c, async () => {})
      if (tooLarge) return tooLarge
      const parsed = parsedBody(assignBody, await c.req.json().catch(() => ({})))
      if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)
      const body = parsed.body
      try {
        const rateLimit = await controlPlaneRateLimitError(services, controlPlaneRateLimiter, auth, {
          key: `hostAssignment.assign:${workspaceId}`,
          action: "host_workspace_assignment.assign.denied",
          workspaceId,
        })
        if (rateLimit) return c.json(rateLimit.body, rateLimit.status)
        const authority = requireAuthority(services)
        await authority.usersMe(auth)
        const assignment = await authority.assignWorkspaceHost(auth, {
          workspaceId,
          hostId: body.hostId,
          ...(body.displayName ? { displayName: body.displayName } : {}),
          ...(body.orgId ? { orgId: body.orgId } : {}),
          ...(body.projectId ? { projectId: body.projectId } : {}),
          ...(body.repoUrl ? { repoUrl: body.repoUrl } : {}),
          ...(body.repoName ? { repoName: body.repoName } : {}),
          ...(body.gitBranch ? { gitBranch: body.gitBranch } : {}),
          ...(body.remoteDirectory ? { remoteDirectory: body.remoteDirectory } : {}),
        })
        await authority.auditAllow(auth, {
          action: "host_workspace_assignment.assigned",
          workspaceId,
          metadata: { hostId: body.hostId },
        })
        captureWorkspaceTelemetry({
          services,
          auth,
          event: "host_workspace_assignment.assigned",
          workspaceId,
          properties: { hostId: body.hostId },
        })
        return c.json({ assignment })
      } catch (err) {
        if (isWorkspaceBackingConflict(err)) return c.json(workspaceBackingConflictBody(), 409)
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        // The authority's own refusals — a directory outside the machine's
        // roots, a workspace in another organization than the invitation's —
        // are the owner's answer, not a server fault.
        if (isClaxedoError(err)) {
          return c.json({ error: apiError(err.code, err.message) }, contentfulStatus(err.status))
        }
        throw err
      }
    },
    unassign: async (c) => {
      const workspaceId = routeParam(c, "id")
      const authResult = await signedOrError(c.req.raw, authOptions, services)
      if ("error" in authResult) return c.json(authResult.error, authResult.status)
      const auth = authResult.auth
      if (!auth) return c.json(missingBearerBody(), 401)
      try {
        const rateLimit = await controlPlaneRateLimitError(services, controlPlaneRateLimiter, auth, {
          key: `hostAssignment.unassign:${workspaceId}`,
          action: "host_workspace_assignment.unassign.denied",
          workspaceId,
        })
        if (rateLimit) return c.json(rateLimit.body, rateLimit.status)
        const authority = requireAuthority(services)
        await authority.usersMe(auth)
        const result = await authority.unassignWorkspaceHost(auth, { workspaceId })
        await authority.auditAllow(auth, {
          action: "host_workspace_assignment.unassigned",
          workspaceId,
          metadata: {},
        })
        return c.json(result)
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    },
  }
}

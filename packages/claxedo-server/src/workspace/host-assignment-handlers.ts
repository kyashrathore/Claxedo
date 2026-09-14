import type { Context } from "hono"
import { z } from "zod"
import {
  ControlPlaneAuthError,
  controlPlaneAuthErrorBody,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority, type WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { isClaxedoError } from "@claxedo/server-core/platform/errors/base"
import { normalizeClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"
import { asRecord } from "@claxedo/helpers/guards"
import type { ControlPlaneServices } from "../authority/services"
import type { ConnectionRateLimiter } from "../platform/auth/rate-limit"
import { contentfulStatus } from "../platform/http/status"
import {
  apiError,
  captureWorkspaceTelemetry,
  configuredRelayUrl,
  hostTunnelCredential,
  missingBearerBody,
  parsedBody,
  signedOrError,
  txt,
  type WorkspaceRouteOptions,
} from "./route-support"
import { controlPlaneRateLimitError } from "./runtime-token-guards"

/**
 * The OWNER's `/api/workspace/:id/host-assignment` verbs against an enrolled
 * machine: assigning a directory on the machine (`POST`, `hostId` in the
 * body) and withdrawing the assignment (`DELETE`). Sharing under machine-wide
 * enrollment has no challenge and no machine signature here — liveness is the
 * enrollment lease and the machine's consent is its heartbeat-acked served
 * set; routing needs all three.
 *
 * Only an account-enrolled machine (the desktop) gets a Host Tunnel Token in
 * the answer: that credential names no enrollment or generation and is not
 * fenced on readiness, and the desktop opens its relay tunnel from it before
 * its first beat. A machine enrolled any other way is served the fenced
 * credential by its heartbeat ack and nothing here.
 *
 * One module for both control planes: the hosted Worker mounts these inside
 * `HostedWorkspaceRoutes`; the self-hosted node answers its own machine's
 * shares itself and dispatches a `hostId` body here.
 */

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

// the authority throws typed-message errors; `workspace_backing_conflict` means the
// caller tried to register a cloud workspace as user-hosted local → 409.
function isWorkspaceBackingConflict(err: unknown) {
  return err instanceof Error && err.message.includes("workspace_backing_conflict")
}

function workspaceBackingConflictBody() {
  return {
    error: apiError(
      "workspace_backing_conflict",
      "Workspace is cloud-backed and cannot be registered as a user-hosted local workspace",
    ),
  }
}

function regionalHostTunnel(
  options: WorkspaceRouteOptions,
  source: unknown,
  hostTunnel: Awaited<ReturnType<typeof hostTunnelCredential>>,
) {
  if (!hostTunnel) return undefined
  const row = asRecord(source)
  const homeRegion = normalizeClaxedoRegion(txt(row?.home_region) ?? txt(row?.homeRegion), options.defaultHomeRegion)
  const relayUrl = configuredRelayUrl(options, homeRegion)
  return {
    ...hostTunnel,
    homeRegion,
    ...(relayUrl ? { relayUrl } : {}),
  }
}

async function accountEnrolled(authority: WorkspaceAuthority, auth: SignedControlPlaneAuth, hostId: string) {
  const machine = await authority.hostEnrollmentByHost?.(auth, { hostId })
  return machine?.enrolled_via === "account"
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
      const workspaceId = c.req.param("id")
      const authResult = await signedOrError(c.req.raw, authOptions, services)
      if ("error" in authResult) return c.json(authResult.error, authResult.status)
      const auth = authResult.auth
      if (!auth) return c.json(missingBearerBody(), 401)
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
        const hostTunnel = await accountEnrolled(authority, auth, body.hostId)
          ? await hostTunnelCredential(options, auth, { hostId: body.hostId, workspaceId })
          : undefined
        return c.json({
          assignment,
          hostTunnel: regionalHostTunnel(options, undefined, hostTunnel),
        })
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
      const workspaceId = c.req.param("id")
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

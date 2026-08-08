import { Hono } from "hono"
import type { ControlPlaneServices } from "../../authority/services"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { ControlPlaneAuthError, controlPlaneAuthConfig, controlPlaneAuthErrorBody } from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import { sandboxFetch } from "../../workspace/http/sandbox-target-fetch"
import { createWorkspaceCheckpointService } from "../../workspace/checkpoints"
import { signedOrError } from "../route-support"
export function WorkspaceCheckpointRoutes(
  services?: ControlPlaneServices,
  options: { loopbackRelayUrl?: string; defaultHomeRegion?: string; allowUnsignedLocal?: boolean } = {},
) {
  return new Hono()
    .get("/:id/checkpoints", async (c) => {
      const access = await authorized(c.req.raw, c.req.param("id"), services, options)
      if ("response" in access) return access.response
      return c.json(await service(access.auth, services!, options).inspect(c.req.param("id")))
    })
    .post("/:id/checkpoints", async (c) => {
      const access = await authorized(c.req.raw, c.req.param("id"), services, options)
      if ("response" in access) return access.response
      const body = await c.req.json().catch(() => ({})) as { policy?: unknown; retentionExpiresAt?: unknown }
      if (body.policy !== undefined && body.policy !== "drain" && body.policy !== "interrupt") {
        return c.json({ error: { code: "workspace_checkpoint_policy_invalid", message: "policy must be drain or interrupt" } }, 400)
      }
      if (body.retentionExpiresAt !== undefined && !Number.isSafeInteger(body.retentionExpiresAt)) {
        return c.json({ error: { code: "workspace_checkpoint_retention_invalid", message: "retentionExpiresAt must be an integer" } }, 400)
      }
      try {
        const result = await service(access.auth, services!, options).capture(c.req.param("id"), {
          ...(body.policy ? { policy: body.policy } : {}),
          ...(typeof body.retentionExpiresAt === "number" ? { retentionExpiresAt: body.retentionExpiresAt } : {}),
        })
        return c.json(result, 201)
      } catch (error) {
        return lifecycleError(c, error)
      }
    })
    .post("/:id/checkpoints/:checkpointId/restore", async (c) => {
      const access = await authorized(c.req.raw, c.req.param("id"), services, options)
      if ("response" in access) return access.response
      const body = await c.req.json().catch(() => ({})) as { approved?: unknown }
      if (body.approved !== true) {
        return c.json({
          error: {
            code: "workspace_lifecycle_approval_required",
            message: "Restore requires explicit approval",
          },
        }, 409)
      }
      try {
        return c.json(await service(access.auth, services!, options).restore(c.req.param("id"), {
          checkpointId: c.req.param("checkpointId"),
        }))
      } catch (error) {
        return lifecycleError(c, error)
      }
    })
    .post("/:id/lifecycle/:operation", async (c) => {
      const access = await authorized(c.req.raw, c.req.param("id"), services, options)
      if ("response" in access) return access.response
      const operation = c.req.param("operation")
      const body = await c.req.json().catch(() => ({})) as { approved?: unknown; checkpointId?: unknown }
      if (!["stop", "replace", "cleanup", "destroy"].includes(operation)) {
        return c.json({ error: { code: "workspace_lifecycle_operation_invalid", message: "Unknown lifecycle operation" } }, 404)
      }
      if (operation !== "stop" && body.approved !== true) {
        return c.json({
          error: {
            code: "workspace_lifecycle_approval_required",
            message: `${operation} requires explicit approval`,
          },
        }, 409)
      }
      try {
        const lifecycle = service(access.auth, services!, options)
        if (operation === "stop") return c.json(await lifecycle.stop(c.req.param("id")))
        if (operation === "replace") {
          return c.json(await lifecycle.replace(c.req.param("id"), {
            ...(typeof body.checkpointId === "string" ? { checkpointId: body.checkpointId } : {}),
          }))
        }
        if (operation === "cleanup") return c.json(await lifecycle.cleanup(c.req.param("id")))
        return c.json(await lifecycle.destroy(c.req.param("id")))
      } catch (error) {
        return lifecycleError(c, error)
      }
    })
}

async function authorized(
  request: Request,
  workspaceId: string,
  services: ControlPlaneServices | undefined,
  options: { allowUnsignedLocal?: boolean },
) {
  if (options.allowUnsignedLocal && services && !services.auth.config.enabled) {
    return { auth: undefined }
  }
  const auth = await signedOrError(request, {
    authConfig: services?.auth.config ?? controlPlaneAuthConfig(),
    requireSigned: true,
  }, services)
  if ("error" in auth) {
    return { response: Response.json(auth.error, { status: auth.status }) }
  }
  if (!auth.auth) {
    return { response: Response.json({ error: { code: "missing_bearer_token", message: "Authorization is required" } }, { status: 401 }) }
  }
  try {
    await requireAuthority(services).authorizeWorkspaceOpen(auth.auth, { workspaceId })
    return { auth: auth.auth }
  } catch (error) {
    if (error instanceof ControlPlaneAuthError) {
      return { response: Response.json(controlPlaneAuthErrorBody(error), { status: error.status }) }
    }
    throw error
  }
}

function service(
  auth: SignedControlPlaneAuth | undefined,
  services: ControlPlaneServices,
  options: { loopbackRelayUrl?: string; defaultHomeRegion?: string; allowUnsignedLocal?: boolean },
) {
  const sandboxManager = services.sandbox.sandboxManager
  if (!sandboxManager) throw new Error("sandbox_manager_unavailable")
  return createWorkspaceCheckpointService({
    sandboxManager,
    inspectRuntimeRequest: async (workspaceId, path, init) => await sandboxFetch({
      id: workspaceId,
      org_id: auth?.user.orgId ?? (auth ? await services.authority!.resolveOrgId(auth) : undefined),
      directory: "/workspace",
      kind: "cloud",
      created_at: 0,
      updated_at: 0,
    }, path, init, {
      sandboxManager,
      relayProvider: services.relay.provider,
      loopbackRelayUrl: options.loopbackRelayUrl,
      defaultHomeRegion: services.defaultHomeRegion ?? options.defaultHomeRegion,
      subject: auth?.user.subject,
      orgId: auth?.user.orgId,
      resume: false,
    }),
    runtimeRequest: async (workspaceId, path, init) => await sandboxFetch({
      id: workspaceId,
      org_id: auth?.user.orgId ?? (auth ? await services.authority!.resolveOrgId(auth) : undefined),
      directory: "/workspace",
      kind: "cloud",
      created_at: 0,
      updated_at: 0,
    }, path, init, {
      sandboxManager,
      relayProvider: services.relay.provider,
      loopbackRelayUrl: options.loopbackRelayUrl,
      defaultHomeRegion: services.defaultHomeRegion ?? options.defaultHomeRegion,
      subject: auth?.user.subject,
      orgId: auth?.user.orgId,
    }),
  })
}

function lifecycleError(c: { json: (body: unknown, status: 409 | 503) => Response }, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const unavailable = message.includes("unavailable") || message.includes("provisioning")
  return c.json({ error: { code: unavailable ? "workspace_checkpoint_unavailable" : "workspace_checkpoint_conflict", message } }, unavailable ? 503 : 409)
}

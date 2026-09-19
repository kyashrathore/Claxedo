import { Hono } from "hono"
import { z } from "zod"
import {
  ControlPlaneAuthError,
  controlPlaneAuthErrorBody,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"

const enableBody = z.object({
  start_at_login: z.boolean().default(false),
}).strict()

const renameBody = z.object({ display_name: z.string().trim().min(1).max(120) }).strict()

const secondDeviceBody = z.object({
  source_client_id: z.string().trim().min(1).max(200),
  current_client_id: z.string().trim().min(1).max(200),
}).strict()

export type RemoteAccessService = {
  status(auth?: SignedControlPlaneAuth): Promise<{ enrolled: boolean; enabled: boolean; secondDeviceOpen: boolean }>
  enable(
    auth: SignedControlPlaneAuth,
    input: { startAtLogin: boolean },
  ): Promise<{ hostId: string; workspaceIds: string[]; connectionCount: number }>
  devices(auth: SignedControlPlaneAuth): Promise<Array<{
    hostId: string
    displayName: string
    lastSeenAt: number
    workspaceIds: string[]
  }>>
  revoke(auth: SignedControlPlaneAuth, hostId: string): Promise<{ revoked: boolean }>
  /**
   * Rename one machine: the owner's override of the name the machine derived
   * for itself. Undefined when the caller owns no enrollment of that host.
   */
  rename(
    auth: SignedControlPlaneAuth,
    input: { hostId: string; displayName: string },
  ): Promise<{ displayName: string } | undefined>
  markSecondDeviceOpen(auth: SignedControlPlaneAuth, workspaceId: string): Promise<{ recorded: boolean }>
}

/** The owner's view of their machines: what every signed control plane serves. */
export type RemoteAccessOwnerService = Pick<RemoteAccessService, "status" | "devices" | "revoke" | "rename" | "markSecondDeviceOpen">

export type RemoteAccessRouteOptions<Service extends RemoteAccessOwnerService> = {
  deviceLoginConfigured: boolean
  relayConfigured: boolean
  /** The signed caller, or the response that refuses the request. */
  authenticate(request: Request): Promise<SignedControlPlaneAuth | Response>
  service: Service
}

async function authenticateRemoteAccess(options: RemoteAccessRouteOptions<RemoteAccessOwnerService>, request: Request) {
  try {
    return await options.authenticate(request)
  } catch (error) {
    if (error instanceof ControlPlaneAuthError) {
      return Response.json(controlPlaneAuthErrorBody(error), { status: error.status })
    }
    throw error
  }
}

/**
 * Remote access has two sides. The OWNER's side — which machines are enrolled,
 * what they serve, when they were last seen, revoke one, record a second-device
 * open — is control-plane data and is served by every signed deployment. The
 * MACHINE's side — enrolling this process as a machine and opening its tunnel
 * — exists only where the server IS a machine (the self-hosted single binary);
 * on the desktop it belongs to the Host Connector, and the hosted control plane
 * has no machine at all.
 */
export function RemoteAccessOwnerRoutes(options: RemoteAccessRouteOptions<RemoteAccessOwnerService>) {
  const app = new Hono()
  const available = options.deviceLoginConfigured && options.relayConfigured

  app.get("/", async (c) => {
    // Per-caller enrollment/enabled state — refuse the anonymous remote
    // caller the same way `/devices`, `/devices/:hostId`, and the
    // second-device route below do. `RemoteAccessService.status` still
    // accepts an absent auth for its own direct callers/tests; this route
    // simply never reaches it without one.
    const auth = await authenticateRemoteAccess(options, c.req.raw)
    // Node's HTTP adapter replaces Response, while Response.json can return the
    // original constructor. Discriminate the trusted auth result by its shape.
    if (!("user" in auth)) return auth
    const result = await options.service.status(auth)
    return c.json({
      device_login_configured: options.deviceLoginConfigured,
      relay_configured: options.relayConfigured,
      hosted_signed_in: true,
      enabled: available && result.enabled,
      enrolled: available && result.enrolled,
      second_device_open: available && result.secondDeviceOpen,
    })
  })

  app.get("/devices", async (c) => {
    const auth = await authenticateRemoteAccess(options, c.req.raw)
    if (!("user" in auth)) return auth
    return c.json({
      devices: (await options.service.devices(auth)).map((device) => ({
        host_id: device.hostId,
        display_name: device.displayName,
        last_seen_at: device.lastSeenAt,
        workspace_ids: device.workspaceIds,
      })),
    })
  })

  app.patch("/devices/:hostId", async (c) => {
    const body = renameBody.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) {
      return c.json({ error: { code: "invalid_display_name", message: "A machine name must be 1 to 120 characters" } }, 400)
    }
    const auth = await authenticateRemoteAccess(options, c.req.raw)
    if (!("user" in auth)) return auth
    const renamed = await options.service.rename(auth, {
      hostId: c.req.param("hostId"),
      displayName: body.data.display_name,
    })
    if (!renamed) {
      return c.json({ error: { code: "host_enrollment_not_found", message: "That machine is not enrolled" } }, 404)
    }
    return c.json({ display_name: renamed.displayName })
  })

  app.delete("/devices/:hostId", async (c) => {
    const auth = await authenticateRemoteAccess(options, c.req.raw)
    if (!("user" in auth)) return auth
    return c.json(await options.service.revoke(auth, c.req.param("hostId")))
  })

  app.post("/workspaces/:workspaceId/second-device-open", async (c) => {
    const body = secondDeviceBody.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success || body.data.source_client_id === body.data.current_client_id) {
      return c.json({
        error: {
          code: "second_device_required",
          message: "The workspace must be opened from a different signed-in client",
        },
      }, 400)
    }
    const auth = await authenticateRemoteAccess(options, c.req.raw)
    if (!("user" in auth)) return auth
    return c.json(await options.service.markSecondDeviceOpen(auth, c.req.param("workspaceId")))
  })

  return app
}

function blockerMessage(deviceLoginConfigured: boolean, relayConfigured: boolean) {
  if (!deviceLoginConfigured && !relayConfigured) return "Device sign-in and the hosted relay are not configured"
  if (!deviceLoginConfigured) return "Device sign-in is not configured"
  return "The hosted relay is not configured"
}

/** The machine's own composition: the owner's routes plus enrolling this process. */
export function RemoteAccessRoutes(options: RemoteAccessRouteOptions<RemoteAccessService>) {
  const app = RemoteAccessOwnerRoutes(options)
  const available = options.deviceLoginConfigured && options.relayConfigured
  app.post("/enable", async (c) => {
    if (!available) {
      return c.json({
        error: {
          code: "remote_access_unavailable",
          message: blockerMessage(options.deviceLoginConfigured, options.relayConfigured),
        },
      }, 501)
    }
    const body = enableBody.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: { code: "remote_access_invalid_body", message: "Invalid remote access settings" } }, 400)
    const auth = await authenticateRemoteAccess(options, c.req.raw)
    if (!("user" in auth)) return auth
    const result = await options.service.enable(auth, { startAtLogin: body.data.start_at_login })
    return c.json({
      host_id: result.hostId,
      workspace_ids: result.workspaceIds,
      connection_count: result.connectionCount,
    })
  })
  return app
}

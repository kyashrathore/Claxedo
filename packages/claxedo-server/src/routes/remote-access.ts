import { Hono } from "hono"
import { z } from "zod"
import {
  ControlPlaneAuthError,
  controlPlaneAuthErrorBody,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"

const renameBody = z.object({ display_name: z.string().trim().min(1).max(120) }).strict()

/** The owner's view of their machines: what every signed control plane serves. */
export type RemoteAccessOwnerService = {
  status(auth?: SignedControlPlaneAuth): Promise<{ enrolled: boolean; enabled: boolean }>
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
}

export type RemoteAccessRouteOptions = {
  deviceLoginConfigured: boolean
  relayConfigured: boolean
  /** The signed caller, or the response that refuses the request. */
  authenticate(request: Request): Promise<SignedControlPlaneAuth | Response>
  service: RemoteAccessOwnerService
}

async function authenticateRemoteAccess(options: RemoteAccessRouteOptions, request: Request) {
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
 * The owner's side of remote access: which machines are enrolled, what they
 * serve, when they were last seen, rename or revoke one. The machine's side —
 * enrolling a process and opening its tunnel — belongs to the Host Connector on
 * the machine itself.
 */
export function RemoteAccessOwnerRoutes(options: RemoteAccessRouteOptions) {
  const app = new Hono()
  const available = options.deviceLoginConfigured && options.relayConfigured

  app.get("/", async (c) => {
    // Per-caller enrollment/enabled state — refuse the anonymous remote
    // caller the same way `/devices` and `/devices/:hostId` below do.
    // `RemoteAccessOwnerService.status` still accepts an absent auth for its own
    // direct callers/tests; this route simply never reaches it without one.
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

  return app
}

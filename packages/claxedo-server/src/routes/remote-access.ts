import { Hono } from "hono"
import { z } from "zod"
import {
  ControlPlaneAuthError,
  controlPlaneAuthErrorBody,
  type SignedControlPlaneAuth,
} from "../authority/auth"

const enableBody = z.object({
  display_name: z.string().trim().min(1).max(120),
  start_at_login: z.boolean().default(false),
}).strict()

const secondDeviceBody = z.object({
  source_client_id: z.string().trim().min(1).max(200),
  current_client_id: z.string().trim().min(1).max(200),
}).strict()

export type RemoteAccessService = {
  status(auth?: SignedControlPlaneAuth): Promise<{ enrolled: boolean; enabled: boolean; secondDeviceOpen: boolean }>
  enable(
    auth: SignedControlPlaneAuth,
    input: { displayName: string; startAtLogin: boolean },
  ): Promise<{ hostId: string; workspaceIds: string[]; connectionCount: number }>
  devices(auth: SignedControlPlaneAuth): Promise<Array<{
    hostId: string
    displayName: string
    lastSeenAt: number
    workspaceIds: string[]
  }>>
  revoke(auth: SignedControlPlaneAuth, hostId: string): Promise<{ revoked: boolean }>
  markSecondDeviceOpen(auth: SignedControlPlaneAuth, workspaceId: string): Promise<{ recorded: boolean }>
}

export function RemoteAccessRoutes(options: {
  deviceLoginConfigured: boolean
  relayConfigured: boolean
  authenticate(request: Request): Promise<SignedControlPlaneAuth>
  service: RemoteAccessService
}) {
  const app = new Hono()
  const available = options.deviceLoginConfigured && options.relayConfigured
  const signed = async (request: Request) => {
    try {
      return await options.authenticate(request)
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) {
        return Response.json(controlPlaneAuthErrorBody(error), { status: error.status })
      }
      throw error
    }
  }

  app.get("/", async (c) => {
    const auth = c.req.header("authorization") ? await signed(c.req.raw) : undefined
    if (auth instanceof Response) return auth
    const result = await options.service.status(auth)
    return c.json({
      device_login_configured: options.deviceLoginConfigured,
      relay_configured: options.relayConfigured,
      hosted_signed_in: !!auth,
      enabled: available && result.enabled,
      enrolled: available && result.enrolled,
      second_device_open: available && result.secondDeviceOpen,
    })
  })

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
    const auth = await signed(c.req.raw)
    if (auth instanceof Response) return auth
    const result = await options.service.enable(auth, {
      displayName: body.data.display_name,
      startAtLogin: body.data.start_at_login,
    })
    return c.json({
      host_id: result.hostId,
      workspace_ids: result.workspaceIds,
      connection_count: result.connectionCount,
    })
  })

  app.get("/devices", async (c) => {
    const auth = await signed(c.req.raw)
    if (auth instanceof Response) return auth
    return c.json({
      devices: (await options.service.devices(auth)).map((device) => ({
        host_id: device.hostId,
        display_name: device.displayName,
        last_seen_at: device.lastSeenAt,
        workspace_ids: device.workspaceIds,
      })),
    })
  })

  app.delete("/devices/:hostId", async (c) => {
    const auth = await signed(c.req.raw)
    if (auth instanceof Response) return auth
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
    const auth = await signed(c.req.raw)
    if (auth instanceof Response) return auth
    return c.json(await options.service.markSecondDeviceOpen(auth, c.req.param("workspaceId")))
  })

  return app
}

function blockerMessage(deviceLoginConfigured: boolean, relayConfigured: boolean) {
  if (!deviceLoginConfigured && !relayConfigured) return "Device sign-in and the hosted relay are not configured"
  if (!deviceLoginConfigured) return "Device sign-in is not configured"
  return "The hosted relay is not configured"
}

/**
 * Tunnel Routes
 *
 * API endpoints for managing tunnel connectivity for remote access.
 */

import { Hono } from "hono"
import { Tunnel, detectTailscale } from "../tunnel"
import { lazy } from "../lazy"

export const TunnelRoutes = lazy(() =>
  new Hono()
    .get("/status", async (c) => {
      const status = Tunnel.getStatus()
      const tailscale = await detectTailscale()
      return c.json({ ...status, tailscale })
    })
    .post("/start", async (c) => {
      const url = await Tunnel.start()
      return c.json({ enabled: true, url })
    })
    .post("/stop", async (c) => {
      await Tunnel.stop()
      return c.json({ enabled: false })
    })
)

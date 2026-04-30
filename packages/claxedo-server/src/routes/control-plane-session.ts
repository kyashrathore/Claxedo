import { Hono } from "hono"
import type { ControlPlaneServices } from "../control-plane/services"
import { resolveSessionGateway } from "../control-plane/trpc"

export function ControlPlaneSessionRoutes(services: ControlPlaneServices) {
  return new Hono()
    .get("/sessions/:sessionId/gateway", async (c) => {
      return c.json(await resolveSessionGateway(services, c.req.param("sessionId")))
    })
}

/**
 * Pages API routes — proxy to OpenCode backend /api/pages
 */
import { Hono } from "hono"
import { lazy } from "../lib/lazy.ts"
import { Config } from "../../config/index.ts"
import { handleCorsPreflight, proxyRequest } from "../proxy/forward.ts"
import type { GatewayContext } from "../context.ts"

export const PagesRoutes = lazy(() =>
  new Hono<GatewayContext>().use("*", async (c) => {
    if (c.req.method === "OPTIONS") return handleCorsPreflight(c)
    return proxyRequest(c, {
      upstreamBase: Config.OPENCODE_URL,
      cors: true,
      responseTag: "x-claxedo-pages",
    })
  }),
)

import { Hono } from "hono"
import { routeParam } from "@claxedo/helpers/route-param"
import { asRecord } from "@claxedo/server-core/platform/json/index"
import { z } from "zod"
import type { ControlPlaneServices } from "../../authority/services"
import { createFixedWindowConnectionRateLimiter, type ConnectionRateLimiter } from "../../platform/auth/rate-limit"
import type { WorkspaceRouteOptions } from "../../workspace/route-support"
import { callMachine, ownedMachine } from "../../workspace/machine-management"
import { signedAccountHandler, tooLarge } from "./host-route-support"

const absolutePath = z.string().min(1).max(1_024)
const foldersBody = z.discriminatedUnion("read", [
  z.object({ read: z.literal("home") }).strict(),
  z.object({ read: z.literal("children"), directory: absolutePath }).strict(),
  z.object({ read: z.literal("search"), directory: absolutePath, query: z.string().max(256), limit: z.number().int().min(1).max(200) }).strict(),
])

const BODY_LIMIT_BYTES = 8 * 1024
const FOLDER_READS_PER_MINUTE = 600
const WINDOW_MS = 60_000

export type HostMachineRouteOptions = WorkspaceRouteOptions & {
  /** The plane's signing keys, which sign each host-management grant. */
  env: Record<string, string | undefined>
  now?: () => number
  folderRateLimiter?: ConnectionRateLimiter
}

/**
 * `/api/claxedo/host/machines/:enrollmentId/*`: what the owner of a connected
 * machine asks of the machine itself, each request carried to it under a
 * grant this plane mints for that request alone.
 */
export function HostMachineRoutes(services: ControlPlaneServices, options: HostMachineRouteOptions) {
  const now = options.now ?? Date.now
  const handle = signedAccountHandler(services, options)
  const folderLimiter = options.folderRateLimiter ?? createFixedWindowConnectionRateLimiter({ limit: FOLDER_READS_PER_MINUTE, windowMs: WINDOW_MS })
  return new Hono()
    .post("/:enrollmentId/folders", tooLarge(BODY_LIMIT_BYTES), handle(foldersBody, async ({ body, auth, c }) => {
      const machine = await ownedMachine(services, auth, routeParam(c, "enrollmentId"), now())
      const answer = await callMachine(services, options.env, auth, machine, {
        operation: "folders.read",
        destination: body.read === "home" ? "~" : body.directory,
        body,
      })
      return asRecord(answer) ?? {}
    }, "POST", { limiter: folderLimiter, key: "host.machines.folders", action: "host_machine.folders.denied" }))
}

/**
 * Loopback control surface for the machine's relay serving connection.
 *
 * Electron main is the only intended caller: it receives the serving
 * credential from the Host Connector child's heartbeat ack and pushes it
 * here, because the DAEMON owns the workspace runtimes and therefore the
 * relay connection that exposes them. The route mutates no account state and
 * carries no account credential — the body is a relay-scoped Host Tunnel
 * Token whose claim the relay itself verifies. Reachability is governed by
 * the daemon's existing local gate (loopback-only in unsigned self-host
 * mode), the same protection every other local admin surface relies on.
 */

import { Hono } from "hono"
import { z } from "zod"
import { setUserHostedServing, userHostedServingState } from "./user-hosted-serving"

const servingBody = z
  .object({
    credential: z
      .object({
        hostId: z.string().min(1).max(300),
        relayUrl: z.string().url().max(2_000),
        token: z.string().min(1).max(8_000),
        workspaceIds: z.array(z.string().min(1).max(200)).max(200),
      })
      .nullable(),
  })
  .strict()

export function UserHostedServingRoutes() {
  return new Hono()
    .get("/", (c) => c.json(userHostedServingState()))
    .put("/", async (c) => {
      const parsed = servingBody.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) {
        return c.json({ error: { code: "invalid_request_body", message: "serving credential failed validation" } }, 400)
      }
      const state = await setUserHostedServing(parsed.data.credential, {
        // The daemon's own origin: this handler only ever runs on a loopback
        // call to the very server whose runtimes the tunnel must reach.
        localBaseUrl: new URL(c.req.url).origin,
      })
      return c.json(state)
    })
}

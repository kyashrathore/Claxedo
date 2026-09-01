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
 *
 * The body is the heartbeat ack's `hostTunnel` object VERBATIM — the control
 * plane is the authoritative producer of this credential and every hop
 * (child → Electron main → here) carries it untouched. Its shape is the
 * signer's `HostTunnelTokenSignerResult` plus the route's own additions
 * (`hostId`, `workspaceIds`, `relayUrl`); see
 * `claxedo-server/src/routes/hosted/host-enrollment.ts` and the type-level
 * pin in `user-hosted-serving-routes.test.ts`. A prior draft invented its own
 * field names here (`token` for `hostTunnelToken`, no `tokenExpiresAt`/`jti`)
 * and the strict parser silently rejected every real ack in production —
 * validate the producer's shape, never a local rendition of it.
 */

import { Hono } from "hono"
import { z } from "zod"
import { setUserHostedServing, userHostedServingState } from "./user-hosted-serving"

const servingBody = z
  .object({
    credential: z
      .object({
        hostId: z.string().min(1).max(300),
        // Optional in the ack (a deployment without a configured relay mints
        // no URL) but required to SERVE: a credential without a relay to dial
        // is treated as invalid rather than silently unroutable.
        relayUrl: z.string().url().max(2_000),
        hostTunnelToken: z.string().min(1).max(8_000),
        tokenExpiresAt: z.number().int().positive(),
        jti: z.string().min(1).max(300),
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
      const credential = parsed.data.credential
      const state = await setUserHostedServing(
        credential
          ? {
              hostId: credential.hostId,
              relayUrl: credential.relayUrl,
              token: credential.hostTunnelToken,
              workspaceIds: credential.workspaceIds,
            }
          : null,
        {
          // The daemon's own origin: this handler only ever runs on a loopback
          // call to the very server whose runtimes the tunnel must reach.
          localBaseUrl: new URL(c.req.url).origin,
        },
      )
      return c.json(state)
    })
}

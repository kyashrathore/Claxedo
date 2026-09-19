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
import { setUserHostedServing, userHostedServingState } from "@claxedo/host-serving/serving"
import { embeddedWorkspaceRuntimeSessionAuthority } from "../deployments/local/embedded-workspace-runtime"
import { setLocalHostEndpoints } from "../deployments/local/host-session-authority"

/**
 * The two addresses a relayed caller is admitted by, carried beside the
 * credential because they arrive on the same heartbeat ack and reach this
 * process by the same hop. Optional: an ack from a control plane that
 * configures neither leaves the daemon verifying relayed requests against the
 * relay's own published key set and refusing every private-session decision,
 * which is the closed answer.
 */
const endpointsBody = z
  .object({
    relayJwksUrl: z.string().url().max(2_000).optional(),
    sessionAuthorityUrl: z.string().url().max(2_000).optional(),
  })
  .strict()

const servingBody = z
  .object({
    endpoints: endpointsBody.optional(),
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
    .get("/", (c) => c.json(userHostedServingState({ sessionAuthority: embeddedWorkspaceRuntimeSessionAuthority })))
    .put("/", async (c) => {
      const parsed = servingBody.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) {
        return c.json({ error: { code: "invalid_request_body", message: "serving credential failed validation" } }, 400)
      }
      const credential = parsed.data.credential
      // Ahead of the tunnel: the first relayed request can arrive as soon as
      // it opens, and it is verified against these.
      setLocalHostEndpoints(credential ? parsed.data.endpoints : undefined)
      const state = await setUserHostedServing(
        credential
          ? {
              hostId: credential.hostId,
              relayUrl: credential.relayUrl,
              token: credential.hostTunnelToken,
              workspaceIds: credential.workspaceIds,
              // Serving is leased on this: no renewing ack before it passes
              // and the tunnel closes, so the daemon cannot keep claiming to
              // serve a machine the control plane has already expired.
              expiresAt: credential.tokenExpiresAt,
            }
          : null,
        {
          // The daemon's own origin: this handler only ever runs on a loopback
          // call to the very server whose runtimes the tunnel must reach.
          localBaseUrl: new URL(c.req.url).origin,
          // How this process composed the embedded runtimes the tunnel exposes;
          // only this process can say, and the control plane refuses to infer it.
          sessionAuthority: embeddedWorkspaceRuntimeSessionAuthority,
        },
      )
      return c.json(state)
    })
}

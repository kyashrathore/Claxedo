/**
 * Loopback control surface for the machine's relay serving connection.
 *
 * Electron main is the only intended caller: it receives the serving
 * credential from the Host Connector child's heartbeat ack and pushes it
 * here, because the DAEMON owns the workspace runtimes and therefore the
 * relay connection that exposes them. The route mutates no account state and
 * carries no account credential — the body is a relay-scoped Host Tunnel
 * Token whose claim the relay itself verifies. Reachability is governed by
 * the daemon's loopback-only local gate, the same protection every other
 * local admin surface relies on.
 *
 * The body is the heartbeat ack's `hostTunnel` object VERBATIM — the control
 * plane is the authoritative producer of this credential and every hop
 * (child → Electron main → here) carries it untouched. Its shape is the
 * signer's `HostTunnelTokenSignerResult` plus the route's own additions
 * (`hostId`, `enrollmentId`, `ownerUserId`, `workspaceIds`, `relayUrl`); see
 * `claxedo-server/src/routes/hosted/host-enrollment.ts` and the type-level
 * pin in `host-serving-routes.test.ts`. The parser is strict, so a field
 * name that is not the producer's rejects every real ack with a 400 that
 * nothing in the chain reports: validate the producer's shape, never a local
 * rendition of it.
 */

import { Hono } from "hono"
import { z } from "zod"
import { setHostServing, hostServingState } from "@claxedo/host-serving/serving"
import { embeddedWorkspaceRuntimeSessionAuthority, syncEmbeddedWorkspaceRuntimes } from "../deployments/local/embedded-workspace-runtime"
import { setLocalHostEndpoints } from "../deployments/local/host-session-authority"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { adoptEnrolledOwner, hostServingUpdates } from "./host-provider-config"

/**
 * The two addresses a relayed caller is admitted by, and the one this machine
 * publishes its session rows to, carried beside the credential because they
 * arrive on the same heartbeat ack and reach this process by the same hop.
 * Optional: an ack from a control plane that configures none leaves the daemon
 * verifying relayed requests against the relay's own published key set,
 * refusing every private-session decision and publishing nothing, which is
 * the closed answer.
 */
const endpointsBody = z
  .object({
    relayJwksUrl: z.string().url().max(2_000).optional(),
    sessionAuthorityUrl: z.string().url().max(2_000).optional(),
    sessionRowsUrl: z.string().url().max(2_000).optional(),
  })
  .strict()

const servingBody = z
  .object({
    endpoints: endpointsBody.optional(),
    credential: z
      .object({
        hostId: z.string().min(1).max(300),
        // The machine's identity to its own clients: the bootstrap declares it
        // so a client can tell a control-plane row placed HERE from one placed
        // on another machine. Required, because a credential that names no
        // enrollment would serve while this daemon told every local client it
        // was some other machine.
        enrollmentId: z.string().min(1).max(200),
        generation: z.number().int().nonnegative().safe(),
        ownerActorId: z.string().min(1).max(200),
        // Optional in the ack (a deployment without a configured relay mints
        // no URL) but required to SERVE: a credential without a relay to dial
        // is treated as invalid rather than silently unroutable.
        relayUrl: z.string().url().max(2_000),
        hostTunnelToken: z.string().min(1).max(8_000),
        tokenExpiresAt: z.number().int().positive(),
        jti: z.string().min(1).max(300),
        workspaceIds: z.array(z.string().min(1).max(200)).max(200),
        // The enrollment's owner; a relayed request authenticated as them is
        // this machine's owner and spends the machine owner's accounts.
        ownerUserId: z.string().min(1).max(300),
      })
      .nullable(),
  })
  .strict()

const log = Log.create({ service: "host-serving-routes" })


export function HostServingRoutes() {
  return new Hono()
    .get("/", (c) => c.json(hostServingState({ sessionAuthority: embeddedWorkspaceRuntimeSessionAuthority })))
    .put("/", async (c) => {
      const parsed = servingBody.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) {
        return c.json({ error: { code: "invalid_request_body", message: "serving credential failed validation" } }, 400)
      }
      return c.json(await hostServingUpdates.run("serving", () => applyServing(parsed.data, new URL(c.req.url).origin)))
    })
}

async function applyServing(body: z.infer<typeof servingBody>, localBaseUrl: string) {
  const credential = body.credential
  // Ahead of the tunnel: the first relayed request can arrive as soon as it
  // opens, and it is verified against these and resolved as this owner.
  setLocalHostEndpoints(credential ? { ...body.endpoints, ownerActorId: credential.ownerActorId } : undefined)
  if (credential) {
    try {
      await adoptEnrolledOwner(credential.ownerUserId, syncEmbeddedWorkspaceRuntimes)
    } catch (error) {
      log.warn("re-applying the runtimes under the enrolled owner failed; the next ack retries", { error: String(error) })
    }
  }
  return await setHostServing(
    credential
      ? {
          hostId: credential.hostId,
          enrollmentId: credential.enrollmentId,
          generation: credential.generation,
          relayUrl: credential.relayUrl,
          token: credential.hostTunnelToken,
          workspaceIds: credential.workspaceIds,
          // Serving is leased on this: no renewing ack before it passes and the
          // tunnel closes, so the daemon cannot keep claiming to serve a
          // machine the control plane has already expired.
          expiresAt: credential.tokenExpiresAt,
        }
      : null,
    {
      // The daemon's own origin: this handler only ever runs on a loopback
      // call to the very server whose runtimes the tunnel must reach.
      localBaseUrl,
      // How this process composed the embedded runtimes the tunnel exposes;
      // only this process can say, and the control plane refuses to infer it.
      sessionAuthority: embeddedWorkspaceRuntimeSessionAuthority,
    },
  )
}

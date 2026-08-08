/**
 * Machine-wide remote-access routes.
 *
 * `routes/hosted/workspace.ts` serves the same handshake per WORKSPACE. These
 * serve it per MACHINE, and there is no `:id` in any path here — that absence
 * is the feature. A user with twelve projects on one laptop enrolls once.
 *
 * The flow, unchanged in shape from the per-workspace one because the security
 * property is the same:
 *
 *   1. POST /requests   → a one-use nonce. Mutates no enrollment.
 *   2. Host Connector signs (hostId, requestId, nonce) with its machine key.
 *   3. POST /           → verify the signature, record the enrollment.
 *   4. POST /heartbeat  → client-signed; extend.
 *   5. POST /pause      → pause one machine, or every machine this owner has.
 *   6. GET  /           → what the settings screen shows.
 *
 * The server never holds the host key. It stores the public half and verifies;
 * `@claxedo/host-connector` holds the private half on the user's machine.
 *
 * The operation matrix names step 3 `host.enrollCurrentMachine`. Nothing here
 * is reachable through a generic proxy — see
 * `docs/tech-docs/desktop-hosted-operation-matrix.md`.
 */

import { Hono, type Context } from "hono"
import { z } from "zod"
import {
  ControlPlaneAuthError,
  controlPlaneAuthConfig,
  controlPlaneAuthErrorBody,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { ControlPlaneServices } from "../../authority/services"
import { parsedBody, signedOrError, type WorkspaceRouteOptions } from "../../workspace/route-support"

const hostId = z.string().trim().min(1).max(200)

const requestBody = z.object({ hostId }).strict()

const enrollBody = z
  .object({
    hostId,
    publicKey: z.string().min(1).max(4_000),
    requestId: z.string().min(1).max(200),
    signature: z.string().min(1).max(4_000),
    displayName: z.string().trim().min(1).max(120).optional(),
    ttlMs: z.number().int().positive().optional(),
  })
  .strict()

const heartbeatBody = z
  .object({ hostId, signature: z.string().min(1).max(4_000), ttlMs: z.number().int().positive().optional() })
  .strict()

const pauseBody = z.object({ hostId: hostId.optional(), paused: z.boolean() }).strict()

function missingBearer() {
  return { error: { code: "unauthorized", message: "Missing bearer token" } }
}

/**
 * The authority may not implement enrollment yet.
 *
 * The port's methods are optional while both authorities are being built out.
 * A 501 that says so beats a `TypeError: not a function` reaching the client as
 * a 500, and it disappears when Unit 6's hard cut makes the methods required.
 */
function unsupported() {
  return { error: { code: "not_implemented", message: "This control plane does not support machine enrollment" } }
}

class EnrollmentUnsupported extends Error {}

export function HostEnrollmentRoutes(services: ControlPlaneServices, options: WorkspaceRouteOptions) {
  const app = new Hono()

  /**
   * Authenticate, resolve the authority, run the handler, map the failures.
   *
   * One wrapper rather than the same fifteen lines in each of five handlers:
   * the interesting part of each route below is two lines, and repeating the
   * auth dance around them is how one of them ends up missing a check.
   */
  const handle = <Body>(
    schema: { safeParse: (input: unknown) => unknown },
    run: (input: {
      body: Body
      auth: SignedControlPlaneAuth
      authority: ReturnType<typeof requireAuthority>
    }) => Promise<unknown>,
    method: "GET" | "POST",
  ) =>
    async (c: Context) => {
      const authResult = await signedOrError(
        c.req.raw,
        // Signed only. There is no unsigned path to machine enrollment: a
        // loopback caller with no account has no account to enroll a machine
        // against.
        { ...options, authConfig: options.authConfig ?? controlPlaneAuthConfig(), requireSigned: true as const },
        services,
      )
      if ("error" in authResult) return c.json(authResult.error, authResult.status as 401 | 403 | 503)
      const auth = authResult.auth
      // Type narrowing, not a second check: `requireSigned: true` above means
      // an unsigned request already returned 401 from `signedOrError`. Removing
      // this line fails no test, because nothing can reach it.
      if (!auth) return c.json(missingBearer(), 401)

      const parsed = method === "GET"
        ? ({ ok: true, body: {} as Body } as const)
        : parsedBody(schema as never, await c.req.json().catch(() => ({})))
      if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)

      try {
        return c.json((await run({ body: parsed.body as Body, auth, authority: requireAuthority(services) })) as never)
      } catch (err) {
        if (err instanceof EnrollmentUnsupported) return c.json(unsupported(), 501)
        if (err instanceof ControlPlaneAuthError) {
          return c.json(controlPlaneAuthErrorBody(err), err.status as 400 | 401 | 403 | 503)
        }
        throw err
      }
    }

  /** Present or 501 — the port's methods are optional until the hard cut. */
  function required<T>(method: T | undefined): NonNullable<T> {
    if (!method) throw new EnrollmentUnsupported()
    return method as NonNullable<T>
  }

  return app
    .post(
      "/requests",
      handle<z.infer<typeof requestBody>>(requestBody, async ({ body, auth, authority }) => {
        const create = required(authority.createHostEnrollmentRequest)
        await authority.usersMe(auth)
        return create(auth, { hostId: body.hostId })
      }, "POST"),
    )
    .post(
      "/",
      handle<z.infer<typeof enrollBody>>(enrollBody, async ({ body, auth, authority }) => {
        const enroll = required(authority.enrollHost)
        await authority.usersMe(auth)
        // The connector signed the nonce with its own private key. This server
        // only records the enrollment — it never holds the host key, and
        // nothing is written until the authority verifies the signature.
        const enrollment = await enroll(auth, {
          hostId: body.hostId,
          publicKey: body.publicKey,
          requestId: body.requestId,
          signature: body.signature,
          ...(body.displayName ? { displayName: body.displayName } : {}),
          ...(body.ttlMs === undefined ? {} : { ttlMs: body.ttlMs }),
        })
        await authority.auditAllow(auth, { action: "host_enrollment.enabled", metadata: { hostId: body.hostId } })
        return { enrollment }
      }, "POST"),
    )
    .post(
      "/heartbeat",
      handle<z.infer<typeof heartbeatBody>>(heartbeatBody, async ({ body, auth, authority }) => {
        const beat = required(authority.heartbeatHostEnrollment)
        return beat(auth, {
          hostId: body.hostId,
          signature: body.signature,
          ...(body.ttlMs === undefined ? {} : { ttlMs: body.ttlMs }),
        })
      }, "POST"),
    )
    .post(
      "/pause",
      handle<z.infer<typeof pauseBody>>(pauseBody, async ({ body, auth, authority }) => {
        const pause = required(authority.pauseHostEnrollment)
        const result = await pause(auth, {
          ...(body.hostId ? { hostId: body.hostId } : {}),
          paused: body.paused,
        })
        await authority.auditAllow(auth, {
          action: body.paused ? "host_enrollment.paused" : "host_enrollment.resumed",
          metadata: { ...(body.hostId ? { hostId: body.hostId } : {}) },
        })
        return result
      }, "POST"),
    )
    .get(
      "/",
      handle<Record<string, never>>(pauseBody, async ({ auth, authority }) => required(authority.activeHostEnrollment)(auth), "GET"),
    )
}

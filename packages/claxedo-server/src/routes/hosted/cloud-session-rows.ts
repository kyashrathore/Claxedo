import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { bearerToken } from "@claxedo/helpers/string"
import { sessionPublicationSchema } from "@claxedo/server-core/session/session-publication"
import type { ControlPlaneServices } from "../../authority/services"
import type { SandboxPassRegister } from "../../platform/auth/sandbox-pass-register"
import type { ControlPlaneEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import {
  CloudSessionRowsConfigurationError,
  mintCloudSessionRowsGrant,
  verifyCloudSessionRowsGrant,
  verifyCloudSessionRowsRenewalGrant,
} from "../../session/cloud-session-rows-grant"

export type CloudSessionRowsRouteOptions = {
  signingEnv: Record<string, string | undefined>
  passes: SandboxPassRegister
  now?: () => number
  notice?: (event: ControlPlaneEvent) => Promise<unknown>
}

const cloudSessionRowsRefusalBody = (code: string, message: string) => ({ error: { code, message } })

/** A cloud runtime presents only its producer pass; user and machine credentials cannot publish here. */
export function CloudSessionRowsRoutes(services: ControlPlaneServices, options: CloudSessionRowsRouteOptions) {
  const app = new Hono()
  const proof = async (request: Request) => {
    const token = bearerToken(request.headers.get("authorization"))
    if (!token) return undefined
    return verifyCloudSessionRowsGrant(token, options.signingEnv, options)
  }
  app.post("/renew", async (c) => {
    try {
      const token = bearerToken(c.req.header("authorization"))
      if (!token) return c.json(cloudSessionRowsRefusalBody("missing_bearer_token", "Cloud producer pass required"), 401)
      const renewal = await verifyCloudSessionRowsRenewalGrant(token, options.signingEnv, options)
      const publisher = renewal.publisher
      if (!await services.authority?.cloudSessionRowsPublisherActive?.(publisher)) {
        return c.json(cloudSessionRowsRefusalBody("cloud_session_rows_producer_ended", "This runtime no longer serves its launch lease"), 403)
      }
      await options.passes.acknowledge(renewal.jti)
      const next = await mintCloudSessionRowsGrant(publisher, options.signingEnv, {
        register: options.passes, renewalOf: renewal.jti, ...(options.now ? { now: options.now } : {}),
      })
      return c.json({ token: next.token, expiresAt: next.expiresAt })
    } catch (error) {
      const misconfigured = error instanceof CloudSessionRowsConfigurationError
      return c.json(cloudSessionRowsRefusalBody(misconfigured ? error.code : "invalid_cloud_session_rows_pass",
        misconfigured ? error.message : "Cloud producer pass refused"), misconfigured ? 503 : 401)
    }
  })
  app.post("/", bodyLimit({
    maxSize: 512 * 1024,
    onError: (c) => c.json(cloudSessionRowsRefusalBody("request_body_too_large", "Session rows exceed the body limit"), 413),
  }), async (c) => {
    const publish = services.authority?.publishCloudSessionRows
    if (!publish || options.notice && (!services.authority?.sessionPublicationNotices)) {
      return c.json(cloudSessionRowsRefusalBody("cloud_session_rows_unavailable", "This control plane takes no cloud session rows"), 501)
    }
    let publisher
    try {
      publisher = await proof(c.req.raw)
    } catch (error) {
      const misconfigured = error instanceof CloudSessionRowsConfigurationError
      return c.json(cloudSessionRowsRefusalBody(misconfigured ? error.code : "invalid_cloud_session_rows_pass",
        misconfigured ? error.message : "Cloud producer pass refused"), misconfigured ? 503 : 401)
    }
    if (!publisher) return c.json(cloudSessionRowsRefusalBody("missing_bearer_token", "Cloud producer pass required"), 401)
    const parsed = sessionPublicationSchema.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) return c.json(cloudSessionRowsRefusalBody("invalid_session_rows", parsed.error.issues[0]?.message ?? "Invalid session rows"), 400)
    const result = await publish(publisher, parsed.data)
    if (options.notice && services.authority?.sessionPublicationNotices) {
      const refused = new Set(result.refused.map((ref) => JSON.stringify([ref.workspaceId, ref.sessionId])))
      const refs = [...parsed.data.rows, ...parsed.data.removed, ...(parsed.data.attention ?? [])]
        .filter((ref) => !refused.has(JSON.stringify([ref.workspaceId, ref.sessionId])))
      const events = await services.authority.sessionPublicationNotices(refs, parsed.data.attention ?? [])
      for (const event of events) await options.notice(event)
    }
    return c.json(result)
  })
  return app
}

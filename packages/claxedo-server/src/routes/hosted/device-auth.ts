/**
 * Hosted device-login endpoints (`/api/auth/device/code`, `/api/auth/device/token`).
 *
 * These let a headless box (`claxedo login`) obtain a signed user credential
 * without a browser. The Worker only brokers the device-code exchange; the
 * configured issuer must still mint credentials that Convex trusts.
 *
 * Until a device-login issuer is configured, these routes FAIL CLOSED with
 * `501 device_login_unconfigured` rather than pretending to issue credentials.
 * This is the documented external-auth dependency for the hosted Worker.
 */

import { Hono, type Context } from "hono"
import {
  ControlPlaneAuthError,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ControlPlaneTokenVerifier,
  type ControlPlaneAuthConfig,
  type SignedControlPlaneAuth,
  type AdapterNativeSessionAuthPort,
} from "@claxedo/server-core/platform/auth/auth"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import { createFixedWindowConnectionRateLimiter, type ConnectionRateLimiter } from "../../platform/auth/rate-limit"

export type HostedDeviceAuthProvider = {
  issuer: string
  codeUrl: string
  tokenUrl: string
  clientId?: string
  audience?: string
  scope?: string
  issuerToken?: string
  fetch?: typeof fetch
}

export type HostedDeviceAuthOptions = {
  authentication?: RequestAuthenticationAdapter
  provider?: HostedDeviceAuthProvider
  authConfig?: ControlPlaneAuthConfig
  verifier?: ControlPlaneTokenVerifier
  native?: AdapterNativeSessionAuthPort
  ensureCliUser?: (auth: SignedControlPlaneAuth) => Promise<unknown>
  /** Per-client limiter for the unauthenticated device endpoints. */
  rateLimiter?: ConnectionRateLimiter
}

function unconfigured() {
  return {
    error: {
      code: "device_login_unconfigured",
      message:
        "Device login is not configured. It is gated on signed-mode Phase A and a Convex-trusted CLI-login issuer.",
    },
  }
}

function object(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
}

function clean(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

function providerHeaders(provider: HostedDeviceAuthProvider) {
  return {
    "content-type": "application/json",
    accept: "application/json",
    ...(provider.issuerToken ? { authorization: `Bearer ${provider.issuerToken}` } : {}),
  }
}

// Audience and scope are SERVER-PINNED: a client-supplied body must never be
// able to widen what the issuer mints the credential for.
function codePayload(provider: HostedDeviceAuthProvider) {
  return {
    ...(provider.clientId ? { client_id: provider.clientId } : {}),
    audience: provider.audience,
    scope: provider.scope,
  }
}

function tokenPayload(provider: HostedDeviceAuthProvider, body: Record<string, unknown>) {
  const deviceCode = clean(body.device_code) ?? clean(body.deviceCode)
  const refreshToken = clean(body.refresh_token) ?? clean(body.refreshToken)
  const grantType = clean(body.grant_type) ?? clean(body.grantType)
  return {
    ...(provider.clientId ? { client_id: provider.clientId } : {}),
    ...(deviceCode ? { device_code: deviceCode } : {}),
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    ...(grantType ? { grant_type: grantType } : refreshToken ? { grant_type: "refresh_token" } : {}),
  }
}

async function broker(provider: HostedDeviceAuthProvider, url: string, payload: Record<string, unknown>) {
  const res = await (provider.fetch ?? fetch)(url, {
    method: "POST",
    headers: providerHeaders(provider),
    body: JSON.stringify(Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined))),
  }).catch(() => undefined)
  if (!res) {
    return Response.json(
      {
        error: {
          code: "device_login_issuer_unreachable",
          message: "Device login issuer did not respond",
        },
      },
      { status: 503 },
    )
  }
  const contentType = res.headers.get("content-type") ?? ""
  if (contentType.includes("application/json")) {
    return Response.json(await res.json().catch(() => ({})), { status: res.status })
  }
  if (res.ok) {
    return Response.json(
      {
        error: {
          code: "device_login_issuer_response_invalid",
          message: "Device login issuer returned a non-JSON response",
        },
      },
      { status: 502 },
    )
  }
  return Response.json(
    {
      error: {
        code: "device_login_issuer_rejected",
        message: `Device login issuer returned ${res.status}`,
      },
    },
    { status: res.status },
  )
}

function rateLimitClientKey(c: Context) {
  return clean(c.req.header("cf-connecting-ip")) ?? clean(c.req.header("x-forwarded-for")?.split(",")[0]) ?? "anonymous"
}

function rateLimited(c: Context, limiter: ConnectionRateLimiter, endpoint: string) {
  const result = limiter.check({ userId: rateLimitClientKey(c), workspaceId: `device-login:${endpoint}` })
  if (result.allowed) return
  return c.json(
    {
      error: {
        code: "device_login_rate_limited",
        message: "Device login request limit exceeded",
        retryAfterMs: result.retryAfterMs,
      },
    },
    429,
  )
}

export function HostedDeviceAuthRoutes(options: HostedDeviceAuthOptions = {}) {
  if (options.authentication && options.native && options.authentication.descriptor.adapter !== options.native.adapter) {
    throw new Error("Native session issuer must belong to the selected request authentication adapter")
  }
  const app = new Hono()
  const provider = options.provider
  // Unauthenticated endpoints: keep a conservative per-client budget.
  const rateLimiter = options.rateLimiter ?? createFixedWindowConnectionRateLimiter({ limit: 30, windowMs: 60_000 })

  app.post("/api/auth/device/code", async (c) => {
    const limited = rateLimited(c, rateLimiter, "code")
    if (limited) return limited
    if (!provider) return c.json(unconfigured(), 501)
    return broker(provider, provider.codeUrl, codePayload(provider))
  })

  app.post("/api/auth/cli/exchange", async (c) => {
    const limited = rateLimited(c, rateLimiter, "cli-exchange")
    if (limited) return limited
    let auth: SignedControlPlaneAuth
    try {
      const context = await controlPlaneAuthContext(c.req.raw, {
        authentication: options.authentication,
        ...(options.authConfig ? { config: options.authConfig } : {}),
        ...(options.verifier ? { verifier: options.verifier } : {}),
      })
      if (context.mode !== "signed") {
        return c.json(
          controlPlaneAuthErrorBody(
            new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required"),
          ),
          401,
        )
      }
      auth = context
    } catch (err) {
      if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status as 401 | 403 | 503)
      throw err
    }
    await options.ensureCliUser?.(auth)
    if (!options.native) {
      return c.json({
        error: {
          code: "cli_token_issuer_unavailable",
          message: "The selected authentication adapter has no native session issuer",
        },
      }, 503)
    }
    try {
      return c.json(await options.native.issue(auth))
    } catch (err) {
      return c.json(
        {
          error: {
            code: "cli_token_issuer_unavailable",
            message: err instanceof Error ? err.message : "CLI token issuer is not configured",
          },
        },
        503,
      )
    }
  })

  app.post("/api/auth/device/token", async (c) => {
    const limited = rateLimited(c, rateLimiter, "token")
    if (limited) return limited
    const body = object(await c.req.json().catch(() => ({})))
    const refreshToken = clean(body.refresh_token) ?? clean(body.refreshToken)
    if (refreshToken && options.native?.acceptsRefreshToken(refreshToken)) {
      try {
        return c.json(await options.native.refresh(refreshToken))
      } catch {
        return c.json(
          {
            error: {
              code: "cli_refresh_token_invalid",
              message: "CLI refresh token is invalid or expired",
            },
          },
          401,
        )
      }
    }
    if (!provider) return c.json(unconfigured(), 501)
    if (
      !clean(body.device_code) &&
      !clean(body.deviceCode) &&
      !clean(body.refresh_token) &&
      !clean(body.refreshToken)
    ) {
      return c.json(
        {
          error: {
            code: "device_or_refresh_token_required",
            message: "device_code or refresh_token is required",
          },
        },
        400,
      )
    }
    return broker(provider, provider.tokenUrl, tokenPayload(provider, body))
  })

  app.post("/api/auth/cli/revoke", async (c) => {
    const limited = rateLimited(c, rateLimiter, "cli-revoke")
    if (limited) return limited
    if (!options.native) {
      return c.json({
        error: { code: "cli_token_issuer_unavailable", message: "The selected authentication adapter has no native session issuer" },
      }, 503)
    }
    const body = object(await c.req.json().catch(() => ({})))
    const token = clean(body.token)
    if (!token) {
      return c.json({ error: { code: "cli_token_required", message: "token is required" } }, 400)
    }
    try {
      const result = await options.native.revoke(token)
      return c.json({ revoked_at: result.revokedAt })
    } catch {
      return c.json({ error: { code: "cli_token_invalid", message: "CLI token is invalid, expired, or revoked" } }, 401)
    }
  })

  return app
}

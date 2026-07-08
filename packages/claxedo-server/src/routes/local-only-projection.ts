import type { MiddlewareHandler } from "hono"
import {
  ControlPlaneAuthError,
  bearerToken,
  controlPlaneAuthConfig,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
} from "../control-plane/auth"

type Options = {
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
  label: string
  missingBearerAsAuthError?: boolean
}

function localOnlyBody(label: string) {
  return {
    error: {
      code: "local_only_projection_route",
      message: `${label} is local-only and is not available through signed/team Control Plane access`,
    },
  }
}

function loopbackHost(input: string) {
  return input === "localhost" || input === "127.0.0.1" || input === "::1" || input === "[::1]"
}

export function isLoopbackLocalRequest(request: Request) {
  const url = new URL(request.url)
  if (!loopbackHost(url.hostname)) return false
  const origin = request.headers.get("origin")
  if (!origin) return true
  try {
    return loopbackHost(new URL(origin).hostname)
  } catch {
    return false
  }
}

export async function localOnlyProjectionResponse(request: Request, options: Options) {
  if (isLoopbackLocalRequest(request)) return
  const config = options.authConfig ?? controlPlaneAuthConfig()
  const token = bearerToken(request.headers.get("authorization"))
  if (!token && options.missingBearerAsAuthError) {
    try {
      await controlPlaneAuthContext(request, {
        config,
        verifier: options.verifier,
      })
      return
    } catch (err) {
      if (err instanceof ControlPlaneAuthError) {
        return Response.json(controlPlaneAuthErrorBody(err), { status: err.status })
      }
      throw err
    }
  }
  if (!token) return Response.json(localOnlyBody(options.label), { status: 403 })
  if (!config.enabled && config.mode === "local-only" && token) {
    return Response.json(localOnlyBody(options.label), { status: 403 })
  }
  try {
    await controlPlaneAuthContext(request, {
      config,
      verifier: options.verifier,
    })
    return Response.json(localOnlyBody(options.label), { status: 403 })
  } catch (err) {
    if (err instanceof ControlPlaneAuthError) {
      return Response.json(controlPlaneAuthErrorBody(err), { status: err.status })
    }
    throw err
  }
}

export function localOnlyProjection(options: Options): MiddlewareHandler {
  return async (c, next) => {
    const response = await localOnlyProjectionResponse(c.req.raw, options)
    if (response) return response
    await next()
  }
}

import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import {
  ControlPlaneAuthError,
  controlPlaneAuthErrorBody,
  type ControlPlaneTokenVerifier,
  type ControlPlaneAuthConfig,
} from "@claxedo/server-core/platform/auth/auth"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import type { PrivateSessionAuthority } from "@claxedo/server-core/platform/auth/private-session-authority"
import type { ControlPlaneServices } from "../authority/services"
import { signedOrError } from "../workspace/route-support"
import { readJsonRecord } from "@claxedo/server-core/platform/json/index"
import { asRecord } from "@claxedo/helpers/guards"

const BODY_LIMIT_BYTES = 16 * 1024
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/

export type PrivateSessionRegistrationRouteOptions = {
  authority: Pick<PrivateSessionAuthority, "reserveSession">
  authentication?: RequestAuthenticationAdapter
  authConfig?: ControlPlaneAuthConfig
  verifier?: ControlPlaneTokenVerifier
  services?: ControlPlaneServices
  /** The harness a session created with none named runs, by the creator's user id; absent, such a session is placed in the workspace's runtime. */
  defaultHarnessId?: (userId: string) => Promise<string | undefined>
}

/**
 * Authenticated, provider-neutral reservation boundary used before a remote
 * runtime creates a session. Registration itself remains on the RHT-authenticated
 * runtime oracle, so neither side can fabricate the other's half of the protocol.
 */
export function PrivateSessionRegistrationRoutes(options: PrivateSessionRegistrationRouteOptions) {
  const limitedBody = bodyLimit({
    maxSize: BODY_LIMIT_BYTES,
    onError: (context) => context.json({
      error: {
        code: "request_body_too_large",
        message: `Request body exceeds the ${BODY_LIMIT_BYTES}-byte limit`,
      },
    }, 413),
  })

  return new Hono().post("/reserve", limitedBody, async (context) => {
    const authenticated = await signedOrError(
      context.req.raw,
      {
        authentication: options.authentication,
        authConfig: options.authConfig,
        verifier: options.verifier,
        requireSigned: true,
      },
      options.services,
    )
    if ("error" in authenticated) {
      return context.json(authenticated.error, authenticated.status)
    }
    if (!authenticated.auth) {
      return context.json({
        error: { code: "signed_auth_required", message: "Signed authentication is required" },
      }, 401)
    }

    const body = await readJsonRecord(context.req.raw)
    const operationId = identifier(body?.operationId)
    const sessionId = identifier(body?.sessionId)
    const workspaceId = identifier(body?.workspaceId)
    const kind = body?.kind
    const parentSessionId = optionalIdentifier(body?.parentSessionId)
    const title = optionalTitle(body?.title)
    const harness = reservedHarness(body?.harness)
    if (
      !operationId
      || !sessionId
      || !workspaceId
      || (kind !== "create" && kind !== "fork")
      || (kind === "create" && parentSessionId !== undefined)
      || (kind === "fork" && !parentSessionId)
      || (body?.parentSessionId !== undefined && parentSessionId === undefined)
      || (body?.title !== undefined && title === undefined)
      || (body?.harness !== undefined && harness === undefined)
    ) {
      return context.json({
        error: {
          code: "session_reservation_request_invalid",
          message: "operationId, sessionId, workspaceId, and a valid create/fork intent are required",
        },
      }, 400)
    }

    try {
      const userId = authenticated.auth.principal?.userId
      const harnessId = harness
        ? harness.access === "native" ? harness.id : harness.access
        : userId ? await options.defaultHarnessId?.(userId) : undefined
      const result = await options.authority.reserveSession(authenticated.auth, {
        operationId,
        sessionId,
        workspaceId,
        kind,
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(title ? { title } : {}),
        ...(harnessId ? { harnessId } : {}),
      })
      return context.json(result, result.changed ? 201 : 200)
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) {
        return context.json(controlPlaneAuthErrorBody(error), error.status)
      }
      const code = errorCode(error)
      if (code) {
        const status = code === "invalid_input" ? 400
          : code === "resource_conflict" ? 409
            : 403
        return context.json({ error: { code, message: errorMessage(error) } }, status)
      }
      throw error
    }
  })
}

function identifier(value: unknown) {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : undefined
}

function optionalIdentifier(value: unknown) {
  return value === undefined ? undefined : identifier(value)
}

function optionalTitle(value: unknown) {
  if (value === undefined) return undefined
  return typeof value === "string" && value.length <= 2_000 ? value : undefined
}

function errorCode(error: unknown) {
  if (!error || typeof error !== "object") return undefined
  const code = (error as { code?: unknown }).code
  return code === "invalid_input"
    || code === "resource_conflict"
    || code === "registration_transition_denied"
    || code === "actor_authorization_denied"
    ? code
    : undefined
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : "Session reservation was denied"
}

function reservedHarness(value: unknown): { id: string; access: "native" | "connection" } | undefined {
  const row = asRecord(value)
  const id = identifier(row?.id)
  const access = row?.access
  if (!row || !id || (access !== "native" && access !== "connection") || Object.keys(row).length !== 2) return undefined
  return { id, access }
}

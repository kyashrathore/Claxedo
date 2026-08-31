import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import {
  ControlPlaneAuthError,
  controlPlaneAuthErrorBody,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import type {
  ApplicationIdentityResolution,
  AuthIdentity,
  RequestAuthenticationAdapter,
} from "@claxedo/server-core/platform/auth/authentication"

import { signedOrError } from "../workspace/route-support"

const BODY_LIMIT_BYTES = 16 * 1024
const MAX_SUBJECT_LENGTH = 512

export type UserDeployedIdentityAdmission = {
  admit(
    auth: SignedControlPlaneAuth,
    input: { identity: AuthIdentity; role: "member" | "admin" },
  ): Promise<ApplicationIdentityResolution>
}

export function UserDeployedIdentityAdmissionRoutes(options: {
  authentication: RequestAuthenticationAdapter
  admission: UserDeployedIdentityAdmission
}) {
  const limited = bodyLimit({
    maxSize: BODY_LIMIT_BYTES,
    onError: (context) => context.json({
      error: {
        code: "request_body_too_large",
        message: `Request body exceeds the ${BODY_LIMIT_BYTES}-byte limit`,
      },
    }, 413),
  })

  return new Hono().post("/user-deployed/identity-admissions", limited, async (context) => {
    const authenticated = await signedOrError(context.req.raw, {
      authentication: options.authentication,
      requireSigned: true,
    })
    if ("error" in authenticated) {
      return context.json(authenticated.error, authenticated.status as 401 | 403 | 503)
    }
    if (!authenticated.auth) {
      return context.json({
        error: { code: "signed_auth_required", message: "Signed authentication is required" },
      }, 401)
    }

    const body = await context.req.json().catch(() => undefined) as Record<string, unknown> | undefined
    const subject = typeof body?.subject === "string" ? body.subject.trim() : ""
    const role = body?.role
    if (!subject || subject.length > MAX_SUBJECT_LENGTH || (role !== "member" && role !== "admin")) {
      return context.json({
        error: {
          code: "identity_admission_request_invalid",
          message: "subject and a member/admin role are required",
        },
      }, 400)
    }

    try {
      const admitted = await options.admission.admit(authenticated.auth, {
        identity: {
          adapter: options.authentication.descriptor.adapter,
          issuer: options.authentication.descriptor.issuer,
          subject,
        },
        role,
      })
      if (admitted.state !== "active") {
        throw new ControlPlaneAuthError(503, "identity_provisioning", "Application identity admission is incomplete")
      }
      return context.json({ admitted: true, role, user: { id: admitted.userId } })
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) {
        return context.json(controlPlaneAuthErrorBody(error), error.status as 401 | 403 | 503)
      }
      const code = authorityErrorCode(error)
      if (code) {
        const status = code === "invalid_input" ? 400 : code === "organization_policy_denied" ? 403 : 409
        return context.json({
          error: { code, message: error instanceof Error ? error.message : "Identity admission failed" },
        }, status)
      }
      throw error
    }
  })
}

function authorityErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return
  const code = (error as { code?: unknown }).code
  return code === "invalid_input"
    || code === "identity_conflict"
    || code === "organization_policy_denied"
    || code === "resource_conflict"
    ? code
    : undefined
}

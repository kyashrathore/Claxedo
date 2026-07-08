import { createRemoteJWKSet, importSPKI, jwtVerify, type JWTPayload, type KeyObject } from "jose"

export const WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER = "x-workspace-runtime-management-token"

export type WorkspaceRuntimeManagementAction = "runtime.config.apply"

export type WorkspaceRuntimeManagementTarget = {
  workspaceId: string
  hostId: string
}

export type WorkspaceRuntimeManagementAuthResult =
  | {
      ok: true
      subject: string
      scopes: string[]
    }
  | {
      ok: false
      status: 401 | 403
      code: string
      message: string
    }

export type WorkspaceRuntimeManagementAuth = {
  authorize(input: {
    request: Request
    action: WorkspaceRuntimeManagementAction
    target: WorkspaceRuntimeManagementTarget
    path: string
    method: string
    snapshot?: {
      revision?: string
      hash?: string
    }
    relayAuth?: unknown
  }): Promise<WorkspaceRuntimeManagementAuthResult>
}

export type WorkspaceRuntimeManagementVerifierKey =
  | CryptoKey
  | KeyObject
  | Uint8Array
  | ((header: { kid?: string; alg?: string }, token: { payload: JWTPayload }) => Promise<CryptoKey | KeyObject | Uint8Array>)

export type LoadWorkspaceRuntimeManagementKeyEnv = {
  WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL?: string | undefined
  WORKSPACE_RUNTIME_MANAGEMENT_VERIFY_PEM?: string | undefined
}

export type WorkspaceRuntimeJwtManagementAuthOptions = {
  key: WorkspaceRuntimeManagementVerifierKey
  issuer: string
  audience: string
  header?: string
}

function text(input: string | undefined) {
  const value = input?.trim()
  return value ? value : undefined
}

function pem(input: string | undefined) {
  return text(input)?.replaceAll("\\n", "\n")
}

function stringClaim(payload: Record<string, unknown>, key: string) {
  const value = payload[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function scopes(payload: Record<string, unknown>) {
  if (Array.isArray(payload.scopes)) return payload.scopes.filter((item): item is string => typeof item === "string")
  if (Array.isArray(payload.scope)) return payload.scope.filter((item): item is string => typeof item === "string")
  if (typeof payload.scope === "string") return payload.scope.split(" ").map((item) => item.trim()).filter(Boolean)
  return []
}

export async function loadWorkspaceRuntimeManagementVerificationKey(
  env: LoadWorkspaceRuntimeManagementKeyEnv,
): Promise<WorkspaceRuntimeManagementVerifierKey> {
  const jwksUrl = text(env.WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL)
  if (jwksUrl) return createRemoteJWKSet(new URL(jwksUrl)) as unknown as WorkspaceRuntimeManagementVerifierKey
  const verifyPem = pem(env.WORKSPACE_RUNTIME_MANAGEMENT_VERIFY_PEM)
  if (!verifyPem) {
    throw new Error(
      "Workspace runtime management verification key is not configured: set WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL or WORKSPACE_RUNTIME_MANAGEMENT_VERIFY_PEM",
    )
  }
  return await importSPKI(verifyPem, "EdDSA")
}

export function createWorkspaceRuntimeJwtManagementAuth(
  options: WorkspaceRuntimeJwtManagementAuthOptions,
): WorkspaceRuntimeManagementAuth {
  return {
    async authorize(input) {
      const token = input.request.headers.get(options.header ?? WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER)?.trim()
      if (!token) {
        return {
          ok: false,
          status: 401,
          code: "runtime_management_token_required",
          message: "Workspace runtime management token is required",
        }
      }

      let payload: Record<string, unknown>
      try {
        const result = await jwtVerify(token, options.key as unknown as Parameters<typeof jwtVerify>[1], {
          issuer: options.issuer,
          audience: options.audience,
        })
        payload = result.payload as Record<string, unknown>
      } catch {
        return {
          ok: false,
          status: 401,
          code: "invalid_runtime_management_token",
          message: "Workspace runtime management token is invalid",
        }
      }

      const tokenScopes = scopes(payload)
      const action = stringClaim(payload, "action")
      if (stringClaim(payload, "workspace_id") !== input.target.workspaceId) {
        return {
          ok: false,
          status: 403,
          code: "runtime_management_workspace_mismatch",
          message: "Workspace runtime management token target is invalid",
        }
      }
      if (stringClaim(payload, "host_id") !== input.target.hostId) {
        return {
          ok: false,
          status: 403,
          code: "runtime_management_host_mismatch",
          message: "Workspace runtime management token target is invalid",
        }
      }
      if (action !== input.action && !tokenScopes.includes(input.action)) {
        return {
          ok: false,
          status: 403,
          code: "runtime_management_action_denied",
          message: "Workspace runtime management token does not grant this action",
        }
      }

      return {
        ok: true,
        subject: stringClaim(payload, "sub") ?? "runtime-management",
        scopes: tokenScopes.includes(input.action) ? tokenScopes : [...tokenScopes, input.action],
      }
    },
  }
}


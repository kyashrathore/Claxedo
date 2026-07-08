import { ConvexHttpClient } from "convex/browser"
import { z } from "zod"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "../../auth"
import type { ConvexExecutor, OrgId, ProjectRole, ProjectRoleResult } from "./convex-authority-types"

const allowResult = z.object({
  allowed: z.literal(true),
})

export function clean(input?: string) {
  const value = input?.trim()
  return value ? value : undefined
}

export function requireExecutor(input?: {
  url?: string
  executor?: ConvexExecutor
}, auth?: SignedControlPlaneAuth, options: { allowUnsigned?: boolean } = {}) {
  if (input?.executor) return input.executor
  if (!auth && !options.allowUnsigned) {
    throw new ControlPlaneAuthError(401, "missing_bearer_token", "Signed Control Plane auth is required")
  }
  const url = input?.url ?? convexUrl()
  if (!url) {
    throw new ControlPlaneAuthError(503, "workspace_authority_unavailable", "Convex authority is not configured")
  }
  return executor(url, auth?.token)
}

export function requireServiceToken(input?: { serviceToken?: string }) {
  const token = clean(input?.serviceToken) ?? serviceToken()
  if (!token) {
    throw new ControlPlaneAuthError(503, "workspace_authority_unavailable", "Control Plane service token is not configured")
  }
  return token
}

export async function requireAllowed(result: unknown) {
  if (allowResult.safeParse(result).success) return
  throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "Convex denied workspace access")
}

export function projectResult(input: unknown): ProjectRoleResult {
  const result = input as { ok?: boolean; role?: ProjectRole; org_id?: string; orgId?: string }
  if (!result.ok || !result.role) return { ok: false }
  const orgId = result.orgId ?? result.org_id
  return orgId ? { ok: true, role: result.role, orgId: orgId as OrgId } : { ok: false }
}

function convexUrl(env: NodeJS.ProcessEnv = process.env) {
  return clean(env.CLAXEDO_WORKSPACE_AUTHORITY_URL)
}

function serviceToken(env: NodeJS.ProcessEnv = process.env) {
  return clean(env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN)
}

function executor(url: string, token?: string): ConvexExecutor {
  const client = new ConvexHttpClient(url)
  if (token) client.setAuth(token)
  return {
    query: (fn, args) => client.query(fn as never, args as never),
    mutation: (fn, args) => client.mutation(fn as never, args as never),
  }
}

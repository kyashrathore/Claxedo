/**
 * Network policy routes — manage outbound egress allowlists.
 */

import { Hono } from "hono"
import { z } from "zod"
import {
  ControlPlaneAuthError,
  bearerToken,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ControlPlaneTokenVerifier,
  type ControlPlaneAuthConfig,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import { controlPlaneAuthConfig } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServicesContract } from "@claxedo/server-core/authority/control-plane-contract"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import {
  createPolicy,
  deletePolicy,
  getPolicy,
  listPolicies,
  resolveEffectivePolicy,
  updatePolicy,
  isTargetAllowed,
} from "@claxedo/server-core/sandbox/network/policy"
import { DEFAULT_ALLOWLIST } from "@claxedo/server-core/sandbox/network/types"
import { errorBody } from "@claxedo/server-core/platform/http/http"

const createBody = z.object({
  workspace_id: z.string().optional(),
  harness: z.string().optional(),
  runner: z.string().optional(),
  target: z.string().min(1),
  kind: z.enum(["host", "domain", "group"]),
  constraints: z
    .object({
      ports: z.array(z.number()).optional(),
      paths: z.array(z.string()).optional(),
      enabled: z.boolean().optional(),
    })
    .optional(),
})

const updateBody = createBody.partial()
type NetworkPolicyBody = z.infer<typeof createBody>

const checkBody = z.object({
  workspace_id: z.string(),
  target: z.string().min(1),
})

type Options = {
  services?: ControlPlaneServicesContract
  authConfig?: ControlPlaneAuthConfig
  verifier?: ControlPlaneTokenVerifier
}

async function routeAuth(request: Request, options: Options) {
  const config = options.authConfig ?? controlPlaneAuthConfig()
  if (!config.enabled && config.mode === "local-only" && !bearerToken(request.headers.get("authorization"))) return
  const context = await controlPlaneAuthContext(request, {
    config,
    verifier: options.verifier,
  })
  return context.mode === "signed" ? context : undefined
}

async function signedOrError(request: Request, options: Options) {
  try {
    return {
      auth: await routeAuth(request, options),
    }
  } catch (err) {
    if (err instanceof ControlPlaneAuthError) {
      return { error: controlPlaneAuthErrorBody(err), status: err.status }
    }
    throw err
  }
}

async function authorizeWorkspace(
  auth: SignedControlPlaneAuth | undefined,
  options: Options,
  workspaceId: string | undefined,
  write = false,
) {
  if (!auth) return
  const authority = requireAuthority(options.services)
  await authority.usersMe(auth)
  if (!workspaceId) {
    throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "Workspace context is required")
  }
  const result = await authority.openWorkspace(auth, { workspaceId })
  if (!write) return
  if (result.role === "owner" || result.role === "admin") return
  throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "Workspace admin access is required")
}

async function authorizeSignedUser(auth: SignedControlPlaneAuth | undefined, options: Options) {
  if (!auth) return
  await requireAuthority(options.services).usersMe(auth)
}

function invalidBody(error: z.ZodError) {
  return errorBody("network_policy_invalid_body", "Invalid network policy request body", error.flatten())
}

function notFound() {
  return errorBody("network_policy_not_found", "Network policy not found")
}

function validationFailed(message: string) {
  return errorBody("network_policy_validation_failed", message)
}

function policyInput(body: NetworkPolicyBody) {
  return {
    workspace_id: body.workspace_id,
    harness: body.harness ?? body.runner,
    target: body.target,
    kind: body.kind,
    constraints: body.constraints,
  }
}

export function NetworkPolicyRoutes(options: Options = {}) {
  return new Hono()
    .onError((err, c) => {
      if (err instanceof ControlPlaneAuthError) {
        return c.json(controlPlaneAuthErrorBody(err), err.status)
      }
      throw err
    })
    .get("/", async (c) => {
      const authResult = await signedOrError(c.req.raw, options)
      if (authResult.error) return c.json(authResult.error, authResult.status)
      const workspaceId = c.req.query("workspace_id")
      await authorizeWorkspace(authResult.auth, options, workspaceId)
      return c.json({ policies: listPolicies(workspaceId) })
    })
    .get("/groups", async (c) => {
      const authResult = await signedOrError(c.req.raw, options)
      if (authResult.error) return c.json(authResult.error, authResult.status)
      await authorizeSignedUser(authResult.auth, options)
      return c.json({ groups: DEFAULT_ALLOWLIST })
    })
    .get("/effective/:workspaceId", async (c) => {
      const authResult = await signedOrError(c.req.raw, options)
      if (authResult.error) return c.json(authResult.error, authResult.status)
      await authorizeWorkspace(authResult.auth, options, c.req.param("workspaceId"))
      const allowed = resolveEffectivePolicy(c.req.param("workspaceId"))
      return c.json({ allowed })
    })
    .post("/check", async (c) => {
      const body = checkBody.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json(invalidBody(body.error), 400)
      const authResult = await signedOrError(c.req.raw, options)
      if (authResult.error) return c.json(authResult.error, authResult.status)
      await authorizeWorkspace(authResult.auth, options, body.data.workspace_id)
      return c.json({
        allowed: isTargetAllowed(body.data.workspace_id, body.data.target),
      })
    })
    .get("/:id", async (c) => {
      const policy = getPolicy(c.req.param("id"))
      if (!policy) return c.json(notFound(), 404)
      const authResult = await signedOrError(c.req.raw, options)
      if (authResult.error) return c.json(authResult.error, authResult.status)
      await authorizeWorkspace(authResult.auth, options, policy.workspace_id ?? undefined)
      return c.json({ policy })
    })
    .post("/", async (c) => {
      const body = createBody.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json(invalidBody(body.error), 400)
      const authResult = await signedOrError(c.req.raw, options)
      if (authResult.error) return c.json(authResult.error, authResult.status)
      await authorizeWorkspace(authResult.auth, options, body.data.workspace_id, true)
      const result = createPolicy(policyInput(body.data))
      if ("error" in result) return c.json(validationFailed(result.error), 400)
      return c.json({ policy: result }, 201)
    })
    .put("/:id", async (c) => {
      const body = updateBody.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json(invalidBody(body.error), 400)
      const authResult = await signedOrError(c.req.raw, options)
      if (authResult.error) return c.json(authResult.error, authResult.status)
      await authorizeWorkspace(authResult.auth, options, body.data.workspace_id ?? getPolicy(c.req.param("id"))?.workspace_id ?? undefined, true)
      const result = updatePolicy(c.req.param("id"), {
        ...body.data,
        harness: body.data.harness ?? body.data.runner,
      })
      if (!result) return c.json(notFound(), 404)
      if ("error" in result) return c.json(validationFailed(result.error), 400)
      return c.json({ policy: result })
    })
    .delete("/:id", async (c) => {
      const authResult = await signedOrError(c.req.raw, options)
      if (authResult.error) return c.json(authResult.error, authResult.status)
      await authorizeWorkspace(authResult.auth, options, getPolicy(c.req.param("id"))?.workspace_id ?? undefined, true)
      const deleted = deletePolicy(c.req.param("id"))
      return c.json({ deleted })
    })
}

import { Hono } from "hono"
import {
  isSandboxDriverID,
  listSandboxDrivers,
  sandboxDriverCredentialFields,
  sandboxDriverId,
  type SandboxDriverEnv,
  type SandboxDriverID,
} from "@claxedo/sandbox-contract"
import {
  loadUserConfig,
  sandboxDriverConfig,
  saveUserConfig,
  setSandboxDriverConfig,
} from "../../agent-config/index"
import type { ControlPlaneCredentials } from "../../authority/control-plane-contract"
import {
  ControlPlaneAuthError,
  bearerToken,
  controlPlaneAuthConfig,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
} from "../../platform/auth/auth"
import { isLoopbackLocalRequest } from "../../platform/http/peer-address"
import { sandboxDriverVerifiable, verifySandboxDriverAuth } from "../../credentials/operations/sandbox-verify"
import type { CredentialProbe } from "../../credentials/operations/discovery"
import { CredentialVerificationError } from "../../credentials/verification-error"

export type SandboxDriverSettingsRouteOptions = {
  credentials: ControlPlaneCredentials
  env?: SandboxDriverEnv
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
  fetch?: typeof fetch
  /** Hosted compositions gate provider inventory with their signed workspace policy. */
  authorizeRead?: (request: Request) => Promise<Response | undefined>
}

export function SandboxDriverSettingsRoutes(options: SandboxDriverSettingsRouteOptions) {
  return new Hono()
    .get("/drivers", async (c) => {
      const denied = await options.authorizeRead?.(c.req.raw)
      if (denied) return denied
      const cfg = await loadUserConfig()
      return c.json(await configuredSandboxDrivers(sandboxDriverConfig(cfg), options))
    })
    .put("/drivers/default", async (c) => {
      const denied = await localSandboxDriverMutationDenied(c.req.raw, options)
      if (denied) return denied
      const body = parseDefaultBody(await c.req.json().catch(() => ({})))
      const driver = sandboxDriverId(body.driver, undefined, options.env)
      if (!driver) return c.json({ error: apiError("sandbox_driver_unsupported", "Unsupported sandbox driver") }, 400)
      const cfg = await loadUserConfig()
      setSandboxDriverConfig(cfg, {
        ...sandboxDriverConfig(cfg),
        default_driver: driver,
      })
      await saveUserConfig(cfg)
      return c.json(await configuredSandboxDrivers(sandboxDriverConfig(cfg), options))
    })
    .put("/drivers/:id/auth", async (c) => {
      const denied = await localSandboxDriverMutationDenied(c.req.raw, options)
      if (denied) return denied
      const driverId = c.req.param("id")
      const id = isSandboxDriverID(driverId) ? driverId : undefined
      if (!id) return c.json({ error: apiError("sandbox_driver_unsupported", "Unsupported sandbox driver") }, 400)
      const body = parseAuthBody(await c.req.json().catch(() => ({})))
      const cfg = await loadUserConfig()

      const verification = await verifySandboxDriverKey(id, body.auth, options)
      if (verification.state === "broken") {
        return c.json(
          { error: apiError("sandbox_driver_key_rejected", "Sandbox provider rejected the key", { reason: verification.reason }) },
          400,
        )
      }

      const secret = sandboxDriverManagedSecret(id, body.auth)
      if (secret) {
        try {
          await options.credentials.putCredential({
            provider_id: id,
            kind: "sandbox_driver",
            source: "managed",
            label: `Sandbox driver ${id}`,
            secret,
          })
        } catch {
          return c.json(
            { error: apiError("sandbox_driver_credential_store_failed", "Failed to store sandbox driver credentials") },
            500,
          )
        }
      }

      setSandboxDriverConfig(cfg, {
        ...sandboxDriverConfig(cfg),
        default_driver: body.default ? id : sandboxDriverConfig(cfg).default_driver,
      })
      await saveUserConfig(cfg)
      return c.json({
        ...await configuredSandboxDrivers(sandboxDriverConfig(cfg), options, { [id]: verification }),
        verification,
      })
    })
    .delete("/drivers/:id/auth", async (c) => {
      const denied = await localSandboxDriverMutationDenied(c.req.raw, options)
      if (denied) return denied
      const driverId = c.req.param("id")
      const id = isSandboxDriverID(driverId) ? driverId : undefined
      if (!id) return c.json({ error: apiError("sandbox_driver_unsupported", "Unsupported sandbox driver") }, 400)
      const cfg = await loadUserConfig()

      await options.credentials.deleteCredentialsByProvider(id, "sandbox_driver").catch(() => {})

      const driverConfig = sandboxDriverConfig(cfg)
      const auth = { ...driverConfig.auth }
      delete auth[id]
      setSandboxDriverConfig(cfg, { ...driverConfig, auth })
      await saveUserConfig(cfg)
      return c.json({ ok: true })
    })
}

async function configuredSandboxDrivers(
  cfg: ReturnType<typeof sandboxDriverConfig>,
  options: SandboxDriverSettingsRouteOptions,
  verdicts: Partial<Record<SandboxDriverID, CredentialProbe>> = {},
) {
  const credentials = await options.credentials.listCredentials().catch(() => [])
  const listing = listSandboxDrivers(
    cfg,
    options.env ?? process.env,
    new Set(
      credentials
        .filter((item) => item.status === "available")
        .map((item) => item.provider_id),
    ),
  )
  return {
    ...listing,
    drivers: listing.drivers.map((driver) => {
      const verdict = verdicts[driver.id]
      return verdict ? { ...driver, verification: verdict } : driver
    }),
  }
}

async function verifySandboxDriverKey(
  id: SandboxDriverID,
  auth: Record<string, string>,
  options: SandboxDriverSettingsRouteOptions,
): Promise<CredentialProbe> {
  if (!sandboxDriverVerifiable(id)) {
    return { state: "unknown", reason: "Claxedo can't check this provider yet — the key was saved as-is." }
  }
  try {
    const health = await verifySandboxDriverAuth(id, auth, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
    })
    if (health === "ok" || health === "rate_capped") return { state: "working" }
    if (health === "no_billing") {
      return {
        state: "broken",
        reason: "That key works, but the provider reports no active billing on the account. Add billing, then save it again.",
      }
    }
    return {
      state: "broken",
      reason: "The provider rejected that key. Check it was copied whole, then save it again.",
    }
  } catch (error) {
    if (error instanceof CredentialVerificationError) return { state: "unknown", reason: inconclusiveCopy(error.message) }
    throw error
  }
}

function inconclusiveCopy(message: string) {
  if (message.includes("does not support verification")) {
    return "Claxedo can't check this provider yet — the key was saved as-is."
  }
  if (message.includes("unsupported shape")) {
    return "Claxedo couldn't read that key well enough to check it — it was saved as-is."
  }
  return "Couldn't reach the provider to check this key — it was saved as-is."
}

function apiError(code: string, message: string, extra?: Record<string, unknown>) {
  return { code, message, ...(extra ?? {}) }
}

function parseDefaultBody(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { driver: undefined }
  const driver = (input as Record<string, unknown>).driver
  return { driver: typeof driver === "string" ? driver : undefined }
}

function parseAuthBody(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { auth: {}, default: undefined }
  const row = input as Record<string, unknown>
  const auth = row.auth && typeof row.auth === "object" && !Array.isArray(row.auth)
    ? Object.fromEntries(Object.entries(row.auth).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {}
  return {
    auth,
    default: typeof row.default === "boolean" ? row.default : undefined,
  }
}

function localSandboxDriverBody() {
  return {
    error: {
      code: "local_only_sandbox_driver",
      message: "Sandbox driver configuration is local-only and is not available through signed/team Control Plane access",
    },
  }
}

async function localSandboxDriverMutationDenied(
  request: Request,
  options: SandboxDriverSettingsRouteOptions,
) {
  if (isLoopbackLocalRequest(request)) return
  const config = options.authConfig ?? controlPlaneAuthConfig()
  const token = bearerToken(request.headers.get("authorization"))
  if (!config.enabled && config.mode === "local-only" && !token) return
  if (!config.enabled && config.mode === "local-only" && token) {
    return Response.json(localSandboxDriverBody(), { status: 403 })
  }
  try {
    await controlPlaneAuthContext(request, { config, verifier: options.verifier })
    return Response.json(localSandboxDriverBody(), { status: 403 })
  } catch (error) {
    if (error instanceof ControlPlaneAuthError) {
      return Response.json(controlPlaneAuthErrorBody(error), { status: error.status })
    }
    throw error
  }
}

function sandboxDriverManagedSecret(id: SandboxDriverID, auth: Record<string, string>) {
  const values = Object.fromEntries(
    sandboxDriverCredentialFields[id].flatMap((field) => {
      const value = auth[field.key]?.trim()
      return value ? [[field.key, value]] : []
    }),
  )
  if (Object.keys(values).length !== sandboxDriverCredentialFields[id].length) return
  return JSON.stringify(values)
}

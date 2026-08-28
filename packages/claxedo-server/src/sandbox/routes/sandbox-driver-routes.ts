import { Hono } from "hono"
import { z } from "zod"
import {
  defaultControlPlaneCredentials,
  type ControlPlaneServices,
} from "../../authority/services"
import {
  ControlPlaneAuthError,
  bearerToken,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
} from "@claxedo/server-core/platform/auth/auth"
import { controlPlaneAuthConfig } from "@claxedo/server-core/platform/auth/clerk-adapter"
import {
  listSandboxDrivers as listSandboxDriverCatalog,
  sandboxDriverId,
} from "@claxedo/sandbox-manager/driver-catalog"
import {
  isSandboxDriverID,
  sandboxDriverCredentialFields,
  type SandboxDriverID,
} from "@claxedo/sandbox-contract"
import {
  loadUserConfig,
  sandboxDriverConfig,
  saveUserConfig,
  setSandboxDriverConfig,
} from "@claxedo/server-core/agent-config/index"
import { isLoopbackLocalRequest } from "@claxedo/server-core/platform/http/peer-address"
import { apiError, signedAccessOptions, signedOrError, type WorkspaceRouteOptions } from "../../workspace/route-support"
import { sandboxDriverVerifiable, verifySandboxDriverAuth } from "@claxedo/server-core/credentials/operations/sandbox-verify"
import { CredentialVerificationError } from "@claxedo/server-core/credentials/verification-error"
import type { CredentialProbe } from "@claxedo/server-core/credentials/operations/discovery"

const authBody = z.object({
  auth: z.record(z.string(), z.string()).default({}),
  default: z.boolean().optional(),
})

const defaultBody = z.object({
  driver: z.string().optional(),
})

export function sandboxDriverRoutes(
  services?: ControlPlaneServices,
  options: WorkspaceRouteOptions = {},
) {
  return new Hono()
    .get("/drivers", async (c) => {
      // Driver configuration discloses which sandbox providers this
      // deployment holds credentials for — inventory, like the workspace
      // list. Signed mode gates it for non-loopback callers; tokenless
      // loopback (the local app) keeps reading it directly.
      const gate = await signedOrError(c.req.raw, signedAccessOptions(c.req.raw, options), services)
      if ("error" in gate) return c.json(gate.error, gate.status)
      const cfg = await loadUserConfig()
      return c.json(await listConfiguredSandboxDrivers(sandboxDriverConfig(cfg), options, services))
    })
    .put("/drivers/default", async (c) => {
      const localOnly = await localSandboxDriverMutationAllowed(c.req.raw, options)
      if (localOnly) return localOnly
      const body = defaultBody.parse(await c.req.json().catch(() => ({})))
      const driver = sandboxDriverId(body.driver)
      if (!driver) return c.json({ error: apiError("sandbox_driver_unsupported", "Unsupported sandbox driver") }, 400)
      const cfg = await loadUserConfig()
      setSandboxDriverConfig(cfg, {
        ...sandboxDriverConfig(cfg),
        default_driver: driver,
      })
      await saveUserConfig(cfg)
      return c.json(await listConfiguredSandboxDrivers(sandboxDriverConfig(cfg), options, services))
    })
    .put("/drivers/:id/auth", async (c) => {
      const localOnly = await localSandboxDriverMutationAllowed(c.req.raw, options)
      if (localOnly) return localOnly
      const driverId = c.req.param("id")
      const id = isSandboxDriverID(driverId) ? driverId : undefined
      if (!id) return c.json({ error: apiError("sandbox_driver_unsupported", "Unsupported sandbox driver") }, 400)
      const body = authBody.parse(await c.req.json().catch(() => ({})))
      const cfg = await loadUserConfig()

      // The credential registry is the ONLY sink for sandbox driver secrets.
      // A failed write used to be swallowed and the raw `body.auth` written
      // verbatim into user-agent-config.json (plaintext, mode 0644) while the
      // response still reported `configured: true` — so the UI showed success
      // while the secret sat on disk in the clear, and nothing surfaced the
      // downgrade. Fail loudly instead: no plaintext copy, no config write, no
      // false success.
      // Verify BEFORE storing. A key the provider rejects must never reach the
      // registry looking configured — that state is exactly what deferred the
      // failure to workspace creation, where nothing ties it back to the key
      // the user pasted. An inconclusive check is not a verdict and never
      // blocks the save: an offline laptop says nothing about the key.
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
          await putSandboxDriverCredential(options, services, id, secret)
        } catch {
          return c.json(
            {
              error: apiError(
                "sandbox_driver_credential_store_failed",
                "Failed to store sandbox driver credentials",
              ),
            },
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
        ...await listConfiguredSandboxDrivers(sandboxDriverConfig(cfg), options, services, { [id]: verification }),
        verification,
      })
    })
    .delete("/drivers/:id/auth", async (c) => {
      const localOnly = await localSandboxDriverMutationAllowed(c.req.raw, options)
      if (localOnly) return localOnly
      const driverId = c.req.param("id")
      const id = isSandboxDriverID(driverId) ? driverId : undefined
      if (!id) return c.json({ error: apiError("sandbox_driver_unsupported", "Unsupported sandbox driver") }, 400)
      const cfg = await loadUserConfig()

      // Kind-scoped: `provider_id` is shared with model providers, so an
      // unscoped delete here also destroyed the user's model API key for any
      // id that exists in both namespaces (e.g. `vercel`).
      await configuredCredentials(options, services).deleteCredentialsByProvider(id, "sandbox_driver").catch(() => {})

      const driverConfig = sandboxDriverConfig(cfg)
      const auth = { ...driverConfig.auth }
      delete auth[id]
      setSandboxDriverConfig(cfg, {
        ...driverConfig,
        auth,
      })
      await saveUserConfig(cfg)
      return c.json({ ok: true })
    })
}

async function listConfiguredSandboxDrivers(
  cfg: ReturnType<typeof sandboxDriverConfig>,
  options: WorkspaceRouteOptions,
  services?: ControlPlaneServices,
  verdicts: Partial<Record<SandboxDriverID, CredentialProbe>> = {},
) {
  const credentials = await configuredCredentials(options, services).listCredentials().catch(() => [])
  const listing = listSandboxDriverCatalog(
    cfg,
    process.env,
    new Set(credentials.filter((item) => item.status === "available").map((item) => item.provider_id)),
  )
  // The step's "ready for cloud sessions" line is only honest if it is backed
  // by a verdict, so it travels on the driver row rather than only on the save
  // response — a re-read of the catalog must be able to say the same thing.
  return {
    ...listing,
    drivers: listing.drivers.map((driver) => {
      const verdict = verdicts[driver.id]
      return verdict ? { ...driver, verification: verdict } : driver
    }),
  }
}

/**
 * A verdict on the key the user just pasted, in the same three-state shape the
 * AI credential probes use: `working`, `broken` (the provider said no), or
 * `unknown` (we could not ask, or this provider has no documented check).
 *
 * `unknown` is deliberately NOT a failure. Refusing a save because the network
 * was down would make a perfectly good key unusable exactly when the user has
 * no way to tell why.
 */
async function verifySandboxDriverKey(
  id: SandboxDriverID,
  auth: Record<string, string>,
  options: WorkspaceRouteOptions,
): Promise<CredentialProbe> {
  if (!sandboxDriverVerifiable(id)) {
    return { state: "unknown", reason: "Claxedo can't check this provider yet — the key was saved as-is." }
  }
  try {
    const health = await verifySandboxDriverAuth(id, auth, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
    })
    // A quota-capped account authenticated: the provider answered and will
    // again once the window rolls over. That is working, not broken.
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

function configuredCredentials(options: WorkspaceRouteOptions, services?: ControlPlaneServices) {
  return options.credentials ?? services?.credentials ?? defaultControlPlaneCredentials()
}

async function putSandboxDriverCredential(
  options: WorkspaceRouteOptions,
  services: ControlPlaneServices | undefined,
  driverId: SandboxDriverID,
  secret: string,
) {
  await configuredCredentials(options, services).putCredential({
    // The credential registry is shared with model/API providers and still
    // stores the lookup key as `provider_id`; sandbox-hosting callers above
    // this boundary should keep using driver terminology.
    provider_id: driverId,
    kind: "sandbox_driver",
    source: "managed",
    label: `Sandbox driver ${driverId}`,
    secret,
  })
}

function localSandboxDriverBody() {
  return {
    error: {
      code: "local_only_sandbox_driver",
      message: "Sandbox driver configuration is local-only and is not available through signed/team Control Plane access",
    },
  }
}

async function localSandboxDriverMutationAllowed(
  request: Request,
  options: WorkspaceRouteOptions,
) {
  if (isLoopbackLocalRequest(request)) return
  const config = options.authConfig ?? controlPlaneAuthConfig()
  const token = bearerToken(request.headers.get("authorization"))
  if (!config.enabled && config.mode === "local-only" && !token) return
  if (!config.enabled && config.mode === "local-only" && token) {
    return Response.json(localSandboxDriverBody(), { status: 403 })
  }
  try {
    await controlPlaneAuthContext(request, {
      config,
      verifier: options.verifier,
    })
    return Response.json(localSandboxDriverBody(), { status: 403 })
  } catch (err) {
    if (err instanceof ControlPlaneAuthError) return Response.json(controlPlaneAuthErrorBody(err), { status: err.status })
    throw err
  }
}

export function sandboxDriverCredentials(options: WorkspaceRouteOptions, services?: ControlPlaneServices) {
  return configuredCredentials(options, services)
}

// Encoder half of the sandbox-driver credential codec. `parseManagedAuth` in
// `sandbox-manager-adapters/driver-auth.ts` is the decoder and MUST stay in
// step with this function — the registry stores one opaque string per
// credential, so a driver with several fields only survives the round trip if
// both halves agree on the encoding.
//
// This used to special-case `daytona` and `docker` to a bare value and JSON
// everything else, while the decoder special-cased a DIFFERENT set (exe, box
// raw). exe.dev and Box therefore round-tripped to the literal string
// `{"api_token":"…"}` — the save succeeded, the UI showed configured, and only
// the sandbox launch saw the corrupt token. One rule now: always JSON. The
// decoder still accepts a bare value so credentials written by the old encoder
// (and by `credentials/migrate.ts`, which writes daytona bare) keep working.
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

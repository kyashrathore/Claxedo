import { Hono } from "hono"
import { z } from "zod"
import {
  defaultControlPlaneCredentials,
  type ControlPlaneServices,
} from "../control-plane/services"
import {
  ControlPlaneAuthError,
  bearerToken,
  controlPlaneAuthConfig,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
} from "../control-plane/auth"
import {
  isSandboxDriverID,
  listSandboxDrivers as listSandboxDriverCatalog,
  sandboxDriverId,
  sandboxDriverCatalog,
  type SandboxDriverID,
} from "@claxedo/sandbox-manager/driver-catalog"
import {
  loadUserConfig,
  sandboxDriverConfig,
  saveUserConfig,
  setSandboxDriverConfig,
} from "../agent-config"
import { isLoopbackLocalRequest } from "./local-only-projection"
import { apiError, type WorkspaceRouteOptions } from "./workspace-user-hosted"

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
      const driverConfig = sandboxDriverConfig(cfg)
      const driverAuth = driverConfig.auth ?? {}

      try {
        const secret = sandboxDriverManagedSecret(id, body.auth)
        if (secret) {
          await putSandboxDriverCredential(options, services, id, secret)
        }
      } catch {
        setSandboxDriverConfig(cfg, {
          ...driverConfig,
          auth: { ...driverAuth, [id]: body.auth },
        })
      }

      setSandboxDriverConfig(cfg, {
        ...sandboxDriverConfig(cfg),
        default_driver: body.default ? id : sandboxDriverConfig(cfg).default_driver,
      })
      await saveUserConfig(cfg)
      return c.json(await listConfiguredSandboxDrivers(sandboxDriverConfig(cfg), options, services))
    })
    .delete("/drivers/:id/auth", async (c) => {
      const localOnly = await localSandboxDriverMutationAllowed(c.req.raw, options)
      if (localOnly) return localOnly
      const driverId = c.req.param("id")
      const id = isSandboxDriverID(driverId) ? driverId : undefined
      if (!id) return c.json({ error: apiError("sandbox_driver_unsupported", "Unsupported sandbox driver") }, 400)
      const cfg = await loadUserConfig()

      await configuredCredentials(options, services).deleteCredentialsByProvider(id).catch(() => {})

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
) {
  const credentials = await configuredCredentials(options, services).listCredentials().catch(() => [])
  return listSandboxDriverCatalog(
    cfg,
    process.env,
    new Set(credentials.filter((item) => item.status === "available").map((item) => item.provider_id)),
  )
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

function sandboxDriverManagedSecret(id: SandboxDriverID, auth: Record<string, string>) {
  const values = Object.fromEntries(
    sandboxDriverCatalog[id].credentialFields.flatMap((field) => {
      const value = auth[field.key]?.trim()
      return value ? [[field.key, value]] : []
    }),
  )
  if (Object.keys(values).length !== sandboxDriverCatalog[id].credentialFields.length) return
  if (id === "daytona") return values.api_key
  if (id === "docker") return values.image
  return JSON.stringify(values)
}

import type { SandboxDriver } from "@claxedo/sandbox-manager"
import { createBoatSandboxDriver } from "@claxedo/sandbox-manager/drivers/boat"
import { createCloudflareSandboxDriver } from "@claxedo/sandbox-manager/drivers/cloudflare"
import { createFetchBridgeSandboxDriver } from "@claxedo/sandbox-manager/drivers/fetch-bridge"
import { sandboxDriverCatalog } from "@claxedo/sandbox-manager/driver-catalog"
import { sandboxDriverIds, type SandboxDriverID } from "@claxedo/sandbox-contract"
import type { HostedSandboxKeys } from "../../../sandbox/org-sandbox-drivers"

import {
  supervisorBackplaneTokenAudience,
  supervisorBackplaneTokenIssuer,
} from "@claxedo/server-core/platform/auth/runtime-access-token"
import { HostedWorkerCompositionError } from "../../composition-error"
import { hostedControlPlaneOrigin } from "./control-plane-origin"
import {
  positiveInteger,
  workspaceRuntimePort,
  type HostedWorkerEnv,
} from "../../provider-neutral-hosted-services"
import { trimToUndefined } from "@claxedo/helpers/string"
import { provisionedRunnerOption } from "@claxedo/server-core/agent-config/connections"

function trimmedOrigin(value: string) {
  return value.replace(/\/+$/g, "")
}

/**
 * What a sandboxed workspace-runtime needs to verify the two callers that
 * reach it — the relay (host tunnel) and this control plane (management) — and
 * where it asks the plane to authorize a session. All of it is derived from
 * values the plane already carries for its own routes, so a full-hosted
 * deployment needs no extra configuration beyond the driver's own.
 */
export function sandboxRuntimeControlEnv(env: HostedWorkerEnv) {
  const relayUrl = trimToUndefined(env.CLAXEDO_WORKSPACE_RELAY_URL)
  const apiOrigin = hostedControlPlaneOrigin(env)
  return {
    ...(relayUrl ? { relayJwksUrl: `${trimmedOrigin(relayUrl)}/.well-known/jwks.json` } : {}),
    ...(trimToUndefined(env.CLAXEDO_RELAY_HOST_VERIFY_PEM) ? { relayVerifyPem: trimToUndefined(env.CLAXEDO_RELAY_HOST_VERIFY_PEM) } : {}),
    ...(apiOrigin
      ? {
          managementJwksUrl: `${trimmedOrigin(apiOrigin)}/.well-known/jwks.json`,
          sessionAuthorityUrl: `${trimmedOrigin(apiOrigin)}/api/runtime-authority/session-authorize`,
        }
      : {}),
  }
}

/**
 * The claims a sandboxed runtime demands of every config push, matching what
 * `mintSupervisorBackplaneToken` signs. The runtime composes no management
 * auth at all without both, and then refuses every snapshot the plane sends.
 */
export function sandboxRuntimeManagementEnv(): Record<string, string> {
  return {
    WORKSPACE_RUNTIME_MANAGEMENT_ISSUER: supervisorBackplaneTokenIssuer,
    WORKSPACE_RUNTIME_MANAGEMENT_AUDIENCE: supervisorBackplaneTokenAudience,
  }
}

function sandboxRuntimeOptions(env: HostedWorkerEnv) {
  return {
    runtimePort: workspaceRuntimePort(env),
    ...(trimToUndefined(env.CLAXEDO_RUNTIME_COMMAND) ? { runtimeCommand: trimToUndefined(env.CLAXEDO_RUNTIME_COMMAND) } : {}),
    ...(trimToUndefined(env.CLAXEDO_RUNTIME_WORKSPACE_DIR) ? { workspaceDir: trimToUndefined(env.CLAXEDO_RUNTIME_WORKSPACE_DIR) } : {}),
    ...provisionedRunnerOption(env),
    controlEnv: sandboxRuntimeControlEnv(env),
    env: sandboxRuntimeManagementEnv,
  }
}

/**
 * Full-hosted sandbox driver selection for a Better Auth + D1 Worker.
 *
 * Only the full-hosted composition imports this module, so a
 * control-plane-only artifact never bundles a sandbox provider. Returns
 * `undefined` when the selected driver's own configuration is incomplete —
 * the composition turns that into a fail-closed error, because a deployment
 * that promised cloud workspaces must not quietly serve without them.
 */
export function hostedSandboxDriver(env: HostedWorkerEnv): SandboxDriver | undefined {
  const name = trimToUndefined(env.CLAXEDO_SANDBOX_DRIVER)?.toLowerCase()
  if (!name) return undefined
  if (name === "cloudflare") {
    return cloudflareDriver(env, { worker_url: env.CLOUDFLARE_SANDBOX_WORKER_URL, api_token: env.CLOUDFLARE_SANDBOX_API_TOKEN })
  }
  if (name === "boat") return boatDriver(env, { api_key: env.BOAT_API_KEY })

  if (name !== "fetch") {
    throw new HostedWorkerCompositionError(
      "hosted_sandbox_driver_unsupported",
      `Hosted Worker sandbox driver must be cloudflare, boat or fetch; got ${name}`,
    )
  }
  const driverUrl = trimToUndefined(env.CLAXEDO_SANDBOX_DRIVER_URL)
  if (!driverUrl) return undefined
  return createFetchBridgeSandboxDriver({
    id: "fetch",
    baseUrl: driverUrl,
    token: trimToUndefined(env.CLAXEDO_SANDBOX_DRIVER_TOKEN),
    autoStopMs: positiveInteger(env, "CLAXEDO_SANDBOX_AUTO_STOP_MS", 30 * 60_000),
    autoDeleteMs: positiveInteger(env, "CLAXEDO_SANDBOX_AUTO_DELETE_MS", 24 * 60 * 60_000),
  })
}

function cloudflareDriver(env: HostedWorkerEnv, auth: { worker_url?: string; api_token?: string }) {
  const workerUrl = trimToUndefined(auth.worker_url)
  const apiToken = trimToUndefined(auth.api_token)
  if (!workerUrl || !apiToken) return undefined
  return createCloudflareSandboxDriver({ workerUrl, apiToken, ...sandboxRuntimeOptions(env) })
}

function boatDriver(env: HostedWorkerEnv, auth: { api_key?: string }) {
  const apiKey = trimToUndefined(auth.api_key)
  const image = trimToUndefined(env.CLAXEDO_SANDBOX_IMAGE)
  if (!apiKey || !image) return undefined
  return createBoatSandboxDriver({ apiKey, image, ...sandboxRuntimeOptions(env) })
}

/**
 * The drivers an organization's own key can provision with on this Worker:
 * the catalog's drivers that run in a Worker. Each is built with the
 * deployment's runtime settings and the organization's key in place of the
 * operator's.
 */
export function hostedSandboxKeyDrivers(env: HostedWorkerEnv): Omit<HostedSandboxKeys, "chosenDriver"> {
  return {
    drivers: sandboxDriverIds.filter((id) => sandboxDriverCatalog[id].metadata.driverRunsIn.some((runtime) => runtime === "worker")),
    create: (id: SandboxDriverID, fields: Record<string, string>) => {
      if (id === "cloudflare") return cloudflareDriver(env, fields)
      if (id === "boat") return boatDriver(env, fields)
      return undefined
    },
  }
}

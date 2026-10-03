import type { SandboxDriver, SandboxDriverEnsureInput } from "@claxedo/sandbox-manager"
import { createCloudflareSandboxDriver } from "@claxedo/sandbox-manager/drivers/cloudflare"
import { createFetchBridgeSandboxDriver } from "@claxedo/sandbox-manager/drivers/fetch-bridge"

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

/**
 * Full-hosted sandbox driver selection for a Better Auth + D1 Worker.
 *
 * Only the full-hosted composition imports this module, so a
 * control-plane-only artifact never bundles a sandbox provider. Returns
 * `undefined` when the selected driver's own configuration is incomplete —
 * the composition turns that into a fail-closed error, because a deployment
 * that promised cloud workspaces must not quietly serve without them.
 */
export function hostedSandboxDriver(env: HostedWorkerEnv, hooks: {
  runtimeEnv?: (input: SandboxDriverEnsureInput, host: { id: string }) => Promise<Record<string, string>>
} = {}): SandboxDriver | undefined {

  const name = trimToUndefined(env.CLAXEDO_SANDBOX_DRIVER)?.toLowerCase()
  if (!name) return undefined
  if (name === "cloudflare") {
    const workerUrl = trimToUndefined(env.CLOUDFLARE_SANDBOX_WORKER_URL)
    const apiToken = trimToUndefined(env.CLOUDFLARE_SANDBOX_API_TOKEN)
    if (!workerUrl || !apiToken) return undefined
    return createCloudflareSandboxDriver({
      workerUrl,
      apiToken,
      runtimePort: workspaceRuntimePort(env),
      ...(trimToUndefined(env.CLAXEDO_RUNTIME_COMMAND) ? { runtimeCommand: trimToUndefined(env.CLAXEDO_RUNTIME_COMMAND) } : {}),
      ...(trimToUndefined(env.CLAXEDO_RUNTIME_WORKSPACE_DIR) ? { workspaceDir: trimToUndefined(env.CLAXEDO_RUNTIME_WORKSPACE_DIR) } : {}),
      ...provisionedRunnerOption(env),
      controlEnv: sandboxRuntimeControlEnv(env),
      env: async (input, host) => ({ ...sandboxRuntimeManagementEnv(), ...await hooks.runtimeEnv?.(input, host) }),
    })
  }

  if (name !== "fetch") {
    throw new HostedWorkerCompositionError(
      "hosted_sandbox_driver_unsupported",
      `Hosted Worker sandbox driver must be cloudflare or fetch; got ${name}`,
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
    ...(hooks.runtimeEnv ? { env: hooks.runtimeEnv } : {}),
  })
}

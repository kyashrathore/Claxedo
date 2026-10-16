import { createBoatSandboxDriver, parseBoatRuntimeTemplate } from "@claxedo/sandbox-manager/drivers/boat"
import { createCloudflareSandboxDriver } from "@claxedo/sandbox-manager/drivers/cloudflare"
import { sandboxDriverCatalog } from "@claxedo/sandbox-manager/driver-catalog"
import { sandboxDriverIds, type SandboxDriverID } from "@claxedo/sandbox-contract"
import type { HostedSandboxKeys } from "../../../sandbox/org-sandbox-drivers"

import {
  supervisorBackplaneTokenAudience,
  supervisorBackplaneTokenIssuer,
} from "@claxedo/server-core/platform/auth/runtime-access-token"
import { HostedWorkerCompositionError } from "../../composition-error"
import { hostedControlPlaneOrigin } from "./control-plane-origin"
import { workspaceRuntimePort, type HostedWorkerEnv } from "../../provider-neutral-hosted-services"
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
 * deployment needs no extra configuration beyond the runtime image.
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

function boatRuntimeTemplate(env: HostedWorkerEnv) {
  const setting = trimToUndefined(env.CLAXEDO_BOAT_RUNTIME_TEMPLATE)
  if (!setting) return undefined
  try {
    return parseBoatRuntimeTemplate(setting)
  } catch (error) {
    throw new HostedWorkerCompositionError("hosted_dependency_invalid", `CLAXEDO_BOAT_RUNTIME_TEMPLATE is unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The catalog's drivers that run inside a Worker: every one an organization key can start a cloud workspace on here. */
export const hostedSandboxKeyDriverIds: readonly SandboxDriverID[] =
  sandboxDriverIds.filter((id) => sandboxDriverCatalog[id].metadata.driverRunsIn.some((runtime) => runtime === "worker"))

/**
 * The drivers an organization's own key provisions with on this Worker, each
 * built from the deployment's runtime settings and the organization's key.
 * The deployment has no provider account of its own: a Boat sandbox boots the
 * runtime image `CLAXEDO_SANDBOX_IMAGE` names, and since every Boat key is
 * offered on every full-hosted deployment, a deployment without the image is
 * refused at composition rather than at the first Boat workspace. The
 * release's runtime template (`CLAXEDO_BOAT_RUNTIME_TEMPLATE`, the share code
 * the deploy publishes) is what a new Boat sandbox of that image starts from.
 */
export function hostedSandboxKeyDrivers(env: HostedWorkerEnv): Omit<HostedSandboxKeys, "chosenDriver"> {
  const image = trimToUndefined(env.CLAXEDO_SANDBOX_IMAGE)
  if (!image) {
    throw new HostedWorkerCompositionError("hosted_dependency_missing", "The full-hosted Worker requires CLAXEDO_SANDBOX_IMAGE, the runtime image a Boat sandbox boots")
  }
  const runtimeTemplate = boatRuntimeTemplate(env)
  return {
    drivers: hostedSandboxKeyDriverIds,
    create: (id: SandboxDriverID, fields: Record<string, string>) => {
      if (id === "cloudflare") {
        const workerUrl = trimToUndefined(fields.worker_url)
        const apiToken = trimToUndefined(fields.api_token)
        return workerUrl && apiToken ? createCloudflareSandboxDriver({ workerUrl, apiToken, ...sandboxRuntimeOptions(env) }) : undefined
      }
      if (id === "boat") {
        const apiKey = trimToUndefined(fields.api_key)
        return apiKey ? createBoatSandboxDriver({ apiKey, image, ...(runtimeTemplate ? { runtimeTemplate } : {}), ...sandboxRuntimeOptions(env) }) : undefined
      }
      return undefined
    },
  }
}

import type { SandboxDriver } from "@claxedo/sandbox-manager"
import { createCloudflareSandboxDriver } from "@claxedo/sandbox-manager/drivers/cloudflare"
import { createDaytonaSandboxDriver } from "@claxedo/sandbox-manager/drivers/daytona"
import { createExeSandboxDriver } from "@claxedo/sandbox-manager/drivers/exe"
import { createFetchBridgeSandboxDriver } from "@claxedo/sandbox-manager/drivers/fetch-bridge"

import { HostedWorkerCompositionError } from "../../composition-error"
import {
  clean,
  positiveInteger,
  workspaceRuntimePort,
  type HostedWorkerEnv,
} from "../../provider-neutral-hosted-services"

/** Convert millisecond lifecycle knobs to the whole minutes Daytona accepts. */
export function lifecycleMinutes(env: HostedWorkerEnv, key: string, fallbackMs: number) {
  return Math.max(1, Math.round(positiveInteger(env, key, fallbackMs) / 60_000))
}

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
  const relayUrl = clean(env.CLAXEDO_WORKSPACE_RELAY_URL)
  const apiOrigin = clean(env.BETTER_AUTH_URL) ?? clean(env.CLAXEDO_PUBLIC_URL)
  return {
    ...(relayUrl ? { relayJwksUrl: `${trimmedOrigin(relayUrl)}/.well-known/jwks.json` } : {}),
    ...(clean(env.CLAXEDO_RELAY_HOST_VERIFY_PEM) ? { relayVerifyPem: clean(env.CLAXEDO_RELAY_HOST_VERIFY_PEM) } : {}),
    ...(apiOrigin
      ? {
          managementJwksUrl: `${trimmedOrigin(apiOrigin)}/.well-known/jwks.json`,
          sessionAuthorityUrl: `${trimmedOrigin(apiOrigin)}/api/runtime-authority/session-authorize`,
        }
      : {}),
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
  const name = clean(env.CLAXEDO_SANDBOX_DRIVER)?.toLowerCase()
  if (!name) return

  if (name === "cloudflare") {
    const workerUrl = clean(env.CLOUDFLARE_SANDBOX_WORKER_URL)
    const apiToken = clean(env.CLOUDFLARE_SANDBOX_API_TOKEN)
    if (!workerUrl || !apiToken) return
    return createCloudflareSandboxDriver({
      workerUrl,
      apiToken,
      runtimePort: workspaceRuntimePort(env),
      ...(clean(env.CLAXEDO_RUNTIME_COMMAND) ? { runtimeCommand: clean(env.CLAXEDO_RUNTIME_COMMAND) } : {}),
      ...(clean(env.CLAXEDO_RUNTIME_WORKSPACE_DIR) ? { workspaceDir: clean(env.CLAXEDO_RUNTIME_WORKSPACE_DIR) } : {}),
      ...(clean(env.CLAXEDO_RUNTIME_RUNNER) ? { runner: clean(env.CLAXEDO_RUNTIME_RUNNER) } : {}),
      controlEnv: sandboxRuntimeControlEnv(env),
    })
  }

  if (name === "daytona") {
    const apiKey = clean(env.DAYTONA_API_KEY)
    const baseSnapshot = clean(env.CLAXEDO_DAYTONA_SNAPSHOT)
    if (!apiKey || !baseSnapshot) return
    return createDaytonaSandboxDriver({
      apiKey,
      baseSnapshot,
      autoStopMinutes: lifecycleMinutes(env, "CLAXEDO_SANDBOX_AUTO_STOP_MS", 30 * 60_000),
      autoDeleteMinutes: lifecycleMinutes(env, "CLAXEDO_SANDBOX_AUTO_DELETE_MS", 24 * 60 * 60_000),
      ...(clean(env.DAYTONA_API_URL) ? { apiUrl: clean(env.DAYTONA_API_URL) } : {}),
      ...(clean(env.DAYTONA_ORGANIZATION_ID) ? { organizationId: clean(env.DAYTONA_ORGANIZATION_ID) } : {}),
      ...(clean(env.DAYTONA_TARGET) ? { target: clean(env.DAYTONA_TARGET) } : {}),
      runtimePort: workspaceRuntimePort(env),
      ...(clean(env.CLAXEDO_RUNTIME_WORKSPACE_DIR) ? { workspaceDir: clean(env.CLAXEDO_RUNTIME_WORKSPACE_DIR) } : {}),
      ...(clean(env.CLAXEDO_RUNTIME_RUNNER) ? { runner: clean(env.CLAXEDO_RUNTIME_RUNNER) } : {}),
      controlEnv: sandboxRuntimeControlEnv(env),
    })
  }

  if (name === "exe") {
    const apiToken = clean(env.EXE_DEV_API_TOKEN)
    if (!apiToken) return
    const control = sandboxRuntimeControlEnv(env)
    const runtimeEnv = {
      ...(control.relayJwksUrl ? { WORKSPACE_RUNTIME_RELAY_JWKS_URL: control.relayJwksUrl } : {}),
      ...(control.relayVerifyPem ? { WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM: control.relayVerifyPem } : {}),
      ...(control.managementJwksUrl ? { WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL: control.managementJwksUrl } : {}),
      ...(control.sessionAuthorityUrl ? { WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL: control.sessionAuthorityUrl } : {}),
    }
    return createExeSandboxDriver({
      apiToken,
      ...(clean(env.EXE_DEV_API_URL) ? { endpoint: clean(env.EXE_DEV_API_URL) } : {}),
      ...(clean(env.CLAXEDO_SANDBOX_IMAGE) ? { image: clean(env.CLAXEDO_SANDBOX_IMAGE) } : {}),
      runtimePort: workspaceRuntimePort(env),
      ...(clean(env.CLAXEDO_RUNTIME_COMMAND) ? { runtimeCommand: clean(env.CLAXEDO_RUNTIME_COMMAND) } : {}),
      ...(clean(env.CLAXEDO_RUNTIME_WORKSPACE_DIR) ? { workspaceDir: clean(env.CLAXEDO_RUNTIME_WORKSPACE_DIR) } : {}),
      ...(clean(env.CLAXEDO_RUNTIME_RUNNER) ? { runner: clean(env.CLAXEDO_RUNTIME_RUNNER) } : {}),
      ...(Object.keys(runtimeEnv).length ? { env: () => runtimeEnv } : {}),
    })
  }

  if (name !== "fetch") {
    throw new HostedWorkerCompositionError(
      "hosted_sandbox_driver_unsupported",
      `Hosted Worker sandbox driver must be one of cloudflare, daytona, exe, or fetch; got ${name}`,
    )
  }
  const driverUrl = clean(env.CLAXEDO_SANDBOX_DRIVER_URL)
  if (!driverUrl) return
  return createFetchBridgeSandboxDriver({
    id: "fetch",
    baseUrl: driverUrl,
    token: clean(env.CLAXEDO_SANDBOX_DRIVER_TOKEN),
    autoStopMs: positiveInteger(env, "CLAXEDO_SANDBOX_AUTO_STOP_MS", 30 * 60_000),
    autoDeleteMs: positiveInteger(env, "CLAXEDO_SANDBOX_AUTO_DELETE_MS", 24 * 60 * 60_000),
  })
}

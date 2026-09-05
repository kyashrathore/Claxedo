import {
  isLoopbackHostname,
  workspaceRuntimeListenHostname,
  type WorkspaceRuntimeServerOptions,
} from "@claxedo/workspace-runtime"
import { createAcpConnectionProvider } from "@claxedo/agent-sdk-runtime"
import { createOpenCodeServerConnectionProvider } from "@claxedo/opencode-server-adapter"
import { isNativeHarnessId } from "@claxedo/server-core/agent-config/connections"
import { workspaceDir, workspaceId } from "@claxedo/workspace-runtime/host"
import {
  loopbackWorkspaceRuntimeExposure,
  privateNetworkDevUnsafeWorkspaceRuntimeExposure,
  relayWorkspaceRuntimeExposure,
} from "@claxedo/workspace-runtime/exposure"
import { workspaceRelayRuntimeOptionsFromEnv } from "@claxedo/workspace-runtime/relay"
import { claxedoCorsOrigin } from "@claxedo/server-core/hosts/workspace-runtime/cors-origin"
import {
  sandboxLeaseEnv,
  workspaceRuntimeDirectAuthEnv,
  workspaceRuntimeTargetEnv,
} from "@claxedo/server-core/hosts/workspace-runtime/env"

export type ClaxedoWorkspaceRuntimeBoot = {
  port: number
  hostname: string
  options: WorkspaceRuntimeServerOptions
}

export function claxedoWorkspaceRuntimeLaunch(input: {
  workspaceId: string
  hostId: string
  sandboxId: string
  leaseId: string
  epoch: number
  directory: string
  port: number
  credential: { token: string; expiresAt: number }
  now?: number
}) {
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 1) {
    throw new Error("workspace-runtime launch requires a positive safe-integer lease epoch")
  }
  assertRuntimePort(input.port, "workspace-runtime launch port")
  if (!input.credential.token.trim()) throw new Error("workspace-runtime launch requires a bootstrap credential")
  const now = input.now ?? Date.now()
  if (!Number.isFinite(now)) throw new Error("workspace-runtime launch requires a finite current timestamp")
  if (!Number.isFinite(input.credential.expiresAt)) {
    throw new Error("workspace-runtime launch requires a finite bootstrap credential expiry")
  }
  if (input.credential.expiresAt <= now) {
    throw new Error("workspace-runtime bootstrap credential is expired")
  }
  return {
    command: ["workspace-runtime"],
    env: {
      ...workspaceRuntimeTargetEnv({
        workspaceId: input.workspaceId,
        hostId: input.hostId,
        directory: input.directory,
        port: input.port,
      }),
      ...sandboxLeaseEnv({
        leaseId: input.leaseId,
        epoch: input.epoch,
        sandboxId: input.sandboxId,
      }),
      ...workspaceRuntimeDirectAuthEnv({ token: input.credential.token }),
      WORKSPACE_RUNTIME_BOOTSTRAP_EXPIRES_AT: String(input.credential.expiresAt),
    },
  }
}

function text(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key]?.trim()
  return value || undefined
}

/**
 * Claxedo's CORS origin policy for its workspace-runtime hosts. This is HOST
 * policy — the product whitelist that used to be baked into the kit lives here
 * so the kit stays product-free. On loopback exposure it allows local dev
 * origins (`http://localhost:*`, `http://127.0.0.1:*`) plus the Claxedo app on
 * the configured HTTPS origin suffixes (CLAXEDO_ALLOWED_ORIGIN_SUFFIXES,
 * default `*.claxedo.com`); every other exposure allows nothing. Both Claxedo
 * hosts (the sandbox host below and the embedded host) pass this.
 */
export { claxedoCorsOrigin } from "@claxedo/server-core/hosts/workspace-runtime/cors-origin"

export function claxedoRuntimeHarnessFromEnv(env: NodeJS.ProcessEnv = process.env): WorkspaceRuntimeServerOptions["harness"] {
  const nativeHarness = text(env, "WORKSPACE_RUNTIME_NATIVE_HARNESS")
  const connectionId = text(env, "WORKSPACE_RUNTIME_CONNECTION_ID")
  if (nativeHarness && connectionId) {
    throw new Error("Choose either WORKSPACE_RUNTIME_NATIVE_HARNESS or WORKSPACE_RUNTIME_CONNECTION_ID")
  }
  if (nativeHarness) {
    if (!isNativeHarnessId(nativeHarness)) {
      throw new Error(`Unsupported WORKSPACE_RUNTIME_NATIVE_HARNESS: ${nativeHarness}`)
    }
    return { kind: "native", harnessId: nativeHarness }
  }
  if (connectionId) return { kind: "connection", connectionId }
}

/**
 * Claxedo's boot policy for its workspace-runtime host: decode the env the
 * supervisor composed (`workspace-supervisor-runtime-env.ts` /
 * `hosts/workspace-runtime/env.ts`) into server options, applying
 * Claxedo's exposure ladder (relay when relay-host auth is present, loopback
 * on loopback hosts, dev-unsafe otherwise).
 *
 * This ladder is HOST policy — it deliberately lives with Claxedo, not in the
 * kit. Other hosts define their own ladder from the same kit parsers
 * (`workspaceRelayRuntimeOptionsFromEnv`, the exposure factories).
 */
export async function claxedoWorkspaceRuntimeBootFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClaxedoWorkspaceRuntimeBoot> {
  const rawPort = text(env, "WORKSPACE_RUNTIME_PORT") ?? "3002"
  if (!/^\d+$/.test(rawPort)) throw new Error(`WORKSPACE_RUNTIME_PORT must be an integer: ${rawPort}`)
  const port = Number(rawPort)
  assertRuntimePort(port, "WORKSPACE_RUNTIME_PORT")
  const hostname = workspaceRuntimeListenHostname(env)
  const relayOptions = await workspaceRelayRuntimeOptionsFromEnv(env, port)
  const options: WorkspaceRuntimeServerOptions = {
    target: { workspaceId: workspaceId(env), directory: workspaceDir(env) },
    ...relayOptions,
    // Relay-host gating must come from env so a runtime spawned as a
    // subprocess (sandbox image) rejects unauthenticated direct access
    // without its parent passing options explicitly.
    exposure: relayOptions.relayHostAuth
      ? relayWorkspaceRuntimeExposure(relayOptions.relayHostAuth)
      : isLoopbackHostname(hostname)
        ? loopbackWorkspaceRuntimeExposure()
        : privateNetworkDevUnsafeWorkspaceRuntimeExposure(
          "WORKSPACE_RUNTIME_ALLOW_UNAUTHENTICATED_NON_LOOPBACK local managed-cloud runtime",
        ),
    harness: claxedoRuntimeHarnessFromEnv(env),
    connectionProviders: [createAcpConnectionProvider(), createOpenCodeServerConnectionProvider()],
    corsOrigin: claxedoCorsOrigin,
  }
  return { port, hostname, options }
}

function assertRuntimePort(port: number, label: string) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} must be an integer between 1 and 65535`)
  }
}

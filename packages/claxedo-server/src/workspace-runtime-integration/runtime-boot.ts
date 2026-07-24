import { normalizeHarnessIdentity } from "@claxedo/agent-sdk-runtime"
import {
  isLoopbackHostname,
  workspaceRuntimeListenHostname,
  type WorkspaceRuntimeCorsOrigin,
  type WorkspaceRuntimeServerOptions,
} from "@claxedo/workspace-runtime"
import type { RuntimeRunner } from "@claxedo/workspace-runtime"
import { workspaceDir, workspaceId } from "@claxedo/workspace-runtime/host"
import {
  loopbackWorkspaceRuntimeExposure,
  privateNetworkDevUnsafeWorkspaceRuntimeExposure,
  relayWorkspaceRuntimeExposure,
} from "@claxedo/workspace-runtime/exposure"
import { workspaceRelayRuntimeOptionsFromEnv } from "@claxedo/workspace-runtime/relay"
import { allowedOriginPatterns } from "../cors-origins"
import {
  sandboxLeaseEnv,
  workspaceRuntimeDirectAuthEnv,
  workspaceRuntimeTargetEnv,
} from "./env"

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
  if (input.epoch < 1) throw new Error("workspace-runtime launch requires a positive lease epoch")
  if (!input.credential.token.trim()) throw new Error("workspace-runtime launch requires a bootstrap credential")
  if (input.credential.expiresAt <= (input.now ?? Date.now())) {
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
 * default `*.claxedo.com` / `*.opencode.ai`); every other exposure allows
 * nothing. Both Claxedo hosts (the sandbox host below and the embedded host)
 * pass this so behavior is identical to the old kit default.
 */
export const claxedoCorsOrigin: WorkspaceRuntimeCorsOrigin = (origin, exposure) => {
  if (exposure.kind !== "loopback") return undefined
  if (origin.startsWith("http://localhost:")) return origin
  if (origin.startsWith("http://127.0.0.1:")) return origin
  const patterns = allowedOriginPatterns(process.env.CLAXEDO_ALLOWED_ORIGIN_SUFFIXES)
  if (patterns.some((pattern) => pattern.test(origin))) return origin
  return undefined
}

export function claxedoRuntimeRunnerFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeRunner {
  const raw = text(env, "WORKSPACE_RUNTIME_RUNNER")
  const identity = raw === "acp"
    ? { id: "claude" as const, access: "acp" as const }
    : normalizeHarnessIdentity(raw ?? "opencode") ?? { id: "opencode" as const, access: "native" as const }
  const acpBinary = text(env, "WORKSPACE_RUNTIME_ACP_BINARY")
  return {
    id: identity.id,
    access: identity.access,
    ...(acpBinary ? { connection: { kind: "process" as const, binary: acpBinary } } : {}),
  }
}

/**
 * Claxedo's boot policy for its workspace-runtime host: decode the env the
 * supervisor composed (`workspace-supervisor-runtime-env.ts` /
 * `workspace-runtime-integration/env.ts`) into server options, applying
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
  const port = parseInt(text(env, "WORKSPACE_RUNTIME_PORT") ?? "3002", 10)
  const hostname = workspaceRuntimeListenHostname(env)
  const relayOptions = await workspaceRelayRuntimeOptionsFromEnv(env, port)
  const opencodeUrl = text(env, "OPENCODE_URL")
  const workgraphConnectionBrokerOrigin = text(env, "WORKSPACE_RUNTIME_WORKGRAPH_BROKER_ORIGIN")
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
    ...(opencodeUrl ? { opencodeUrl } : {}),
    ...(workgraphConnectionBrokerOrigin ? { workgraphConnectionBrokerOrigin } : {}),
    ...(workgraphConnectionBrokerOrigin ? { workgraphAttemptBrokerOrigin: workgraphConnectionBrokerOrigin } : {}),
    harness: claxedoRuntimeRunnerFromEnv(env),
    corsOrigin: claxedoCorsOrigin,
    // Claxedo keeps OpenCode compat ON unless its env flag disables it. The
    // env var is the wire format of this HOST decision across the process
    // boundary; the kit itself never reads it (option-only).
    opencodeCompat: env.WORKSPACE_RUNTIME_OPENCODE_COMPAT !== "0",
  }
  return { port, hostname, options }
}

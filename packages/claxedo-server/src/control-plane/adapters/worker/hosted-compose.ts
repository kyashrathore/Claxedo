/**
 * Worker-side authority/lease composition adapter.
 *
 * This is the Claxedo Worker adapter: it is the ONLY hosted-composition module
 * allowed to reach the Convex-backed authority and lease-store adapters. The
 * generic hosted composition (`hosted-services.ts`) delegates every
 * Convex-touching decision here, so no generic control-plane core file has to
 * name the storage backend.
 *
 * It also owns the small fail-closed env primitives shared with
 * `hosted-services.ts` (`HostedWorkerCompositionError`, `required`, `clean`,
 * `positiveInteger`) so the whole Worker composition reads from one place.
 */

import { DEFAULT_WORKSPACE_RUNTIME_PORT, createSandboxManager } from "@claxedo/sandbox-manager"
import type { SandboxDriver, SandboxManager } from "@claxedo/sandbox-manager"
import { createConvexLeaseStore } from "../../../sandbox-manager-adapters/stores/convex"
import { convexAuthorityUrlFromEnv, createConvexAuthority } from "../convex/convex-authority"
import { cliSessionTokenAuthority } from "../convex/convex-authority-cli-session-tokens"
import { createUserHostedTargetResolver } from "../convex/user-hosted-relay-target"
import type { WorkspaceAuthority } from "../../authority"
import {
  authorityCliSessionTokenRegistry,
  unavailableCliSessionTokenRegistry,
  type CliSessionTokenRegistry,
} from "../../cli-session-registry"
import type { UserHostedTargetResolver } from "../../sandbox-relay-target"

export class HostedWorkerCompositionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export type HostedWorkerEnv = Record<string, string | undefined>

export function clean(value: string | undefined) {
  const v = value?.trim()
  return v ? v : undefined
}

export function required(value: string | undefined, code: string, name: string): string {
  const v = clean(value)
  if (!v) throw new HostedWorkerCompositionError(code, `Hosted Worker control plane requires ${name}`)
  return v
}

export function positiveInteger(env: HostedWorkerEnv, key: string, fallback: number) {
  const raw = clean(env[key])
  if (!raw) return fallback
  const parsed = Number(raw)
  if (Number.isInteger(parsed) && parsed > 0) return parsed
  throw new HostedWorkerCompositionError("hosted_safety_limit_invalid", `${key} must be a positive integer`)
}

export function workspaceRuntimePort(env: HostedWorkerEnv) {
  return positiveInteger(env, "WORKSPACE_RUNTIME_PORT", DEFAULT_WORKSPACE_RUNTIME_PORT)
}

/** Resolve the hosted storage endpoint (fails closed when absent). */
function storageUrl(env: HostedWorkerEnv): string {
  return required(
    convexAuthorityUrlFromEnv(env),
    "hosted_dependency_missing",
    "a workspace authority URL (CLAXEDO_WORKSPACE_AUTHORITY_URL)",
  )
}

/**
 * Build the hosted SandboxManager for a selected driver, backed by the hosted
 * durable lease store. Fails closed if the service token is missing (every
 * lease call would otherwise be rejected at request time).
 */
export function composeWorkerSandboxManager(input: {
  env: HostedWorkerEnv
  driver: SandboxDriver
  maxRetryCount: number
}): SandboxManager {
  const { env, driver, maxRetryCount } = input
  return createSandboxManager({
    leaseStore: createConvexLeaseStore({
      url: storageUrl(env),
      // The hosted runtime-lease functions are service-only and reject calls
      // without the token: composing without it would 500 every lease call,
      // so fail closed at composition time instead.
      token: required(
        env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN,
        "hosted_dependency_missing",
        "a Convex Control Plane service token (CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN) when a sandbox driver is configured",
      ),
    }),
    driver,
    staleAfterMs: positiveInteger(env, "CLAXEDO_SANDBOX_ACQUIRE_STALE_MS", 60_000),
    retryAfterMs: positiveInteger(env, "CLAXEDO_SANDBOX_PROVISIONING_RETRY_MS", 2_000),
    maxRetryCount,
  })
}

/** Build the hosted workspace authority from env. */
export function composeWorkerAuthority(env: HostedWorkerEnv): WorkspaceAuthority {
  const serviceToken = clean(env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN)
  return createConvexAuthority({
    url: storageUrl(env),
    ...(serviceToken ? { serviceToken } : {}),
  })
}

/**
 * Build the DURABLE CLI session token registry from env.
 *
 * `storageUrl` already fails composition closed when the hosted storage
 * endpoint is missing. The service token is handled differently — NOT because
 * it is optional, but because hosted composition deliberately tolerates its
 * absence elsewhere (`composeWorkerAuthority` passes it through only when
 * present; the sandbox manager requires it only once a bridge driver is
 * configured), and this module is not the place to overturn that.
 *
 * So a deployment missing the token still gets a registry object — one that
 * refuses every operation with a message naming the variable to set. The CLI
 * path then behaves exactly as it must: no minting an unrevocable credential,
 * no accepting a bearer nothing can check. What changes is the diagnostic. The
 * previous failure was a bare "registry is not configured" with nothing to act
 * on, because there was no registry anywhere in the hosted composition at all.
 */
export function composeWorkerCliSessionTokenRegistry(env: HostedWorkerEnv): CliSessionTokenRegistry {
  const serviceToken = clean(env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN)
  if (!serviceToken) {
    return unavailableCliSessionTokenRegistry(
      "CLI session tokens cannot be recorded or revoked: set CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN on the hosted control plane",
    )
  }
  return authorityCliSessionTokenRegistry(
    cliSessionTokenAuthority({ url: storageUrl(env), serviceToken }),
  )
}

/**
 * Build the service-authenticated user-hosted target resolver, or undefined
 * when no service token is configured.
 */
export function composeWorkerUserHostedResolver(env: HostedWorkerEnv): UserHostedTargetResolver | undefined {
  const serviceToken = clean(env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN)
  if (!serviceToken) return
  return createUserHostedTargetResolver({
    convexUrl: storageUrl(env),
    serviceToken,
  })
}

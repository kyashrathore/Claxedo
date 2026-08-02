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
import type { SandboxDriver, SandboxEgressUnenforcedEvent, SandboxManager } from "@claxedo/sandbox-manager"
import { createConvexLeaseStore } from "../../../adapters/sandbox/stores/convex"
import { convexAuthorityUrlFromEnv, createConvexAuthority } from "../convex/workspace-authority"
import { cliSessionTokenAuthority } from "../convex/cli-session-tokens"
import { createUserHostedTargetResolver } from "../convex/user-hosted-relay-target"
import type { WorkspaceAuthority } from "../../authority"
import {
  authorityCliSessionTokenRegistry,
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
  /**
   * Sink for the manager's "this driver cannot contain egress" warning. Passed
   * through so the hosted plane can put the event somewhere an operator will
   * actually see it — `console.warn` in a Worker only reaches whoever happens
   * to be tailing logs. Omitted → the manager's console default.
   */
  onEgressUnenforced?: (event: SandboxEgressUnenforcedEvent) => void
}): SandboxManager {
  const { env, driver, maxRetryCount } = input
  return createSandboxManager({
    ...(input.onEgressUnenforced ? { onEgressUnenforced: input.onEgressUnenforced } : {}),
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
  return createConvexAuthority({
    url: storageUrl(env),
    serviceToken: required(
      env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN,
      "hosted_dependency_missing",
      "a Convex Control Plane service token (CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN)",
    ),
  })
}

/** Build the durable CLI session token registry from env. */
export function composeWorkerCliSessionTokenRegistry(env: HostedWorkerEnv): CliSessionTokenRegistry {
  return authorityCliSessionTokenRegistry(
    cliSessionTokenAuthority({
      url: storageUrl(env),
      serviceToken: required(
        env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN,
        "hosted_dependency_missing",
        "a Convex Control Plane service token (CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN)",
      ),
    }),
  )
}

/** Build the service-authenticated user-hosted target resolver. */
export function composeWorkerUserHostedResolver(env: HostedWorkerEnv): UserHostedTargetResolver {
  return createUserHostedTargetResolver({
    convexUrl: storageUrl(env),
    serviceToken: required(
      env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN,
      "hosted_dependency_missing",
      "a Convex Control Plane service token (CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN)",
    ),
  })
}

/**
 * Retained Clerk + Convex hosted composition.
 *
 * Provider-neutral construction lives in `provider-neutral-hosted-services`.
 * This wrapper is the only production composition edge that selects the
 * retained adapters, so importing a Better Auth + D1 entrypoint never pulls
 * Clerk or Convex into that artifact.
 */

import { clerkAuthAdapter } from "@claxedo/server-core/platform/auth/clerk-adapter"
import { createClerkNativeSessionAuthPort } from "@claxedo/server-core/platform/auth/cli-session-token"

import { createConvexLeaseStore } from "../sandbox/stores/convex"
import {
  composeWorkerAuthority,
  composeWorkerCliSessionTokenRegistry,
  composeWorkerUserHostedResolver,
} from "./adapters/worker/hosted-compose"
import { lifecycleMinutes, sandboxDriver } from "./adapters/worker/retained-sandbox-driver"
import {
  composeProviderNeutralHostedControlPlane,
  hostedDeviceAuthProvider,
  required,
  type HostedControlPlane,
  type HostedWorkerEnv,
} from "./provider-neutral-hosted-services"
import { convexAuthorityUrlFromEnv } from "./adapters/convex/workspace-authority"
import { HostedWorkerCompositionError } from "./composition-error"

export * from "./provider-neutral-hosted-services"
export { lifecycleMinutes, sandboxDriver } from "./adapters/worker/retained-sandbox-driver"

/** Preserve the existing public factory as the retained Clerk + Convex adapter wrapper. */
export function composeHostedControlPlane(env: HostedWorkerEnv): HostedControlPlane {
  const selected = clerkAuthAdapter({ env })
  if (!selected.config.enabled) {
    throw new HostedWorkerCompositionError(
      "hosted_auth_disabled",
      `Hosted Worker control plane requires enabled signed auth: ${selected.config.reason}`,
    )
  }

  const authority = composeWorkerAuthority(env)
  const cliSessionTokenRegistry = composeWorkerCliSessionTokenRegistry(env)
  const auth = clerkAuthAdapter({
    env,
    native: createClerkNativeSessionAuthPort({ env, registry: cliSessionTokenRegistry }),
  })
  const storageUrl = required(
    convexAuthorityUrlFromEnv(env),
    "hosted_dependency_missing",
    "a workspace authority URL (CLAXEDO_WORKSPACE_AUTHORITY_URL)",
  )
  const serviceToken = required(
    env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN,
    "hosted_dependency_missing",
    "a Convex Control Plane service token (CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN)",
  )
  const driver = sandboxDriver(env)
  const deviceAuthProvider = hostedDeviceAuthProvider(env)

  return composeProviderNeutralHostedControlPlane(env, {
    auth,
    authority,
    privateSessionAuthority: authority,
    runtimeSessionAuthority: authority,
    cliSessionTokenRegistry,
    userHostedResolver: composeWorkerUserHostedResolver(env),
    ...(driver
      ? { sandbox: { driver, leaseStore: createConvexLeaseStore({ url: storageUrl, token: serviceToken }) } }
      : {}),
    ...(deviceAuthProvider ? { deviceAuthProvider } : {}),
  })
}

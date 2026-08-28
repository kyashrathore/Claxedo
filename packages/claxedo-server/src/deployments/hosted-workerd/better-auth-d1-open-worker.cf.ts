import type { D1Database } from "@cloudflare/workers-types"
import type { ExecutionContext } from "hono"
import {
  requestIsHttps,
  securityHeaderEntries,
  withSecurityHeaders,
} from "@claxedo/server-core/platform/http/security-headers"
import { EMPTY_SERVICE_MANIFEST_ID } from "@claxedo/service-contract"

import {
  composeBetterAuthD1UserDeployedControlPlane,
  type BetterAuthD1UserDeployedComposition,
} from "../../authority/adapters/worker/better-auth-d1-compose"
import type { HostedWorkerEnv } from "../../authority/provider-neutral-hosted-services"
import { resolveBetterAuthConfiguration } from "../../platform/auth/better-auth-configuration"
import { createHostedCoreWorker, LiveSyncRoom, type HostedCoreWorkerEnv } from "./core-worker.cf"
import {
  betterAuthD1ReleaseIdentity,
  requiredReleaseIdentifier,
  type BetterAuthD1ReleaseIdentityEnv,
} from "./better-auth-d1-release-identity.cf"
import { requireDeploymentReleaseState } from "./better-auth-d1-release-state.cf"
import { requirePairedD1RecoveryEpoch } from "./paired-d1-recovery.cf"

export { LiveSyncRoom }

export type BetterAuthD1OpenWorkerEnv = HostedCoreWorkerEnv &
  BetterAuthD1ReleaseIdentityEnv & {
    AUTH_DB: D1Database
    CONTROL_PLANE_DB: D1Database
    CLAXEDO_RECOVERY_EPOCH?: string
    CLAXEDO_BROWSER_BUILD_ID?: string
    CLAXEDO_RELAY_BUILD_ID?: string
    CLAXEDO_AUTH_DESCRIPTOR_EXPIRES_AT?: string
    CLAXEDO_ENVIRONMENT_ID?: string
    CLAXEDO_USER_DEPLOYED_ORGANIZATION_ID?: string
    CLAXEDO_USER_DEPLOYED_ORGANIZATION_NAME?: string
    CLAXEDO_AUTH_METHODS?: string
    BETTER_AUTH_URL?: string
    CLAXEDO_APP_ORIGIN?: string
    BETTER_AUTH_SECRET?: string
    CLAXEDO_AUTH_INTROSPECTION_SECRET?: string
    GOOGLE_CLIENT_ID?: string
    GOOGLE_CLIENT_SECRET?: string
    GITHUB_CLIENT_ID?: string
    GITHUB_CLIENT_SECRET?: string
  }

const compositionByEnvironment = new WeakMap<object, BetterAuthD1UserDeployedComposition>()

function stringEnvironment(env: BetterAuthD1OpenWorkerEnv): HostedWorkerEnv {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function futureTimestamp(value: string | undefined, name: string) {
  const parsed = Number(requiredReleaseIdentifier(value, name))
  if (!Number.isFinite(parsed) || parsed <= Date.now()) throw new Error(`${name} must be a future finite timestamp`)
  return parsed
}

function composition(env: BetterAuthD1OpenWorkerEnv) {
  const key = env as object
  const existing = compositionByEnvironment.get(key)
  if (existing) return existing
  const created = composeBetterAuthD1UserDeployedControlPlane({
    env: stringEnvironment(env),
    authDatabase: env.AUTH_DB,
    controlPlaneDatabase: env.CONTROL_PLANE_DB,
    environmentId: requiredReleaseIdentifier(env.CLAXEDO_ENVIRONMENT_ID, "CLAXEDO_ENVIRONMENT_ID"),
    descriptorExpiresAt: futureTimestamp(env.CLAXEDO_AUTH_DESCRIPTOR_EXPIRES_AT, "CLAXEDO_AUTH_DESCRIPTOR_EXPIRES_AT"),
    product: {
      kind: "user-deployed",
      organization: {
        id: requiredReleaseIdentifier(
          env.CLAXEDO_USER_DEPLOYED_ORGANIZATION_ID,
          "CLAXEDO_USER_DEPLOYED_ORGANIZATION_ID",
        ),
        name: requiredReleaseIdentifier(
          env.CLAXEDO_USER_DEPLOYED_ORGANIZATION_NAME,
          "CLAXEDO_USER_DEPLOYED_ORGANIZATION_NAME",
        ),
      },
      ownerBootstrap: "one-use-claim",
    },
  })
  compositionByEnvironment.set(key, created)
  return created
}

const core = createHostedCoreWorker<BetterAuthD1OpenWorkerEnv>((env) => {
  const selected = composition(env)
  return { plane: selected.plane, options: selected.options }
})

function configuredAuth(env: BetterAuthD1OpenWorkerEnv) {
  return resolveBetterAuthConfiguration({ env: stringEnvironment(env) })
}

function authRoute(pathname: string) {
  return (
    pathname === "/.well-known/oauth-authorization-server" ||
    pathname === "/api/auth" ||
    pathname.startsWith("/api/auth/")
  )
}

function unavailable(request: Request) {
  return withSecurityHeaders(
    Response.json({ error: { code: "deployment_unavailable" } }, { status: 503 }),
    securityHeaderEntries({
      https: requestIsHttps({ url: request.url, header: (name) => request.headers.get(name) ?? undefined }),
    }),
  )
}

const handler = {
  async fetch(request: Request, env: BetterAuthD1OpenWorkerEnv, context?: ExecutionContext) {
    try {
      if (!env.AUTH_DB || !env.CONTROL_PLANE_DB) throw new Error("AUTH_DB and CONTROL_PLANE_DB are required")
      const configured = configuredAuth(env)
      const url = new URL(request.url)
      if (url.origin !== configured.public.apiOrigin) {
        throw new Error("observed request origin does not match BETTER_AUTH_URL")
      }
      const identity = await betterAuthD1ReleaseIdentity(env, configured, {
        browserBuildId: requiredReleaseIdentifier(env.CLAXEDO_BROWSER_BUILD_ID, "CLAXEDO_BROWSER_BUILD_ID"),
        relayBuildId: requiredReleaseIdentifier(env.CLAXEDO_RELAY_BUILD_ID, "CLAXEDO_RELAY_BUILD_ID"),
        serviceManifestId: EMPTY_SERVICE_MANIFEST_ID,
      })
      const release = await requireDeploymentReleaseState(env.AUTH_DB, identity)
      if (release.phase !== "open") throw new Error(`open Worker refuses persisted state ${release.phase}`)
      await requirePairedD1RecoveryEpoch(env.AUTH_DB, env.CONTROL_PLANE_DB, {
        deploymentId: identity.deploymentId,
        releaseId: identity.releaseId,
        recoveryEpoch: requiredReleaseIdentifier(env.CLAXEDO_RECOVERY_EPOCH, "CLAXEDO_RECOVERY_EPOCH"),
      })

      const selected = composition(env)
      if (authRoute(url.pathname)) return await selected.authHandler(request)
      return await core.fetch(request, env, context)
    } catch (error) {
      console.error("[better-auth-d1-open] deployment is unavailable", error)
      return unavailable(request)
    }
  },
}

export default handler

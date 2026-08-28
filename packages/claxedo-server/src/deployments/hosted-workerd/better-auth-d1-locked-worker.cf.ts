import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider"
import type { D1Database } from "@cloudflare/workers-types"
import {
  requestIsHttps,
  securityHeaderEntries,
  withSecurityHeaders,
} from "@claxedo/server-core/platform/http/security-headers"

import { resolveBetterAuthConfiguration } from "../../platform/auth/better-auth-configuration"
import { createBetterAuthD1Foundation } from "../../platform/auth/better-auth-d1-foundation"
import {
  betterAuthNativeResource,
  requireBetterAuthDatabaseSchema,
  requireBetterAuthNativeClientClosure,
} from "../../platform/auth/better-auth-native-clients"
import {
  LOCKED_BROWSER_BUILD_ID,
  LOCKED_RELAY_BUILD_ID,
  LOCKED_SERVICE_MANIFEST_ID,
  requireDeploymentReleaseCandidateAtRevision,
  requireDeploymentReleaseState,
  type DeploymentReleaseIdentity,
} from "./better-auth-d1-release-state.cf"
import { deploymentAdmissionBinding } from "./better-auth-d1-cutover-gate.cf"
import { requirePairedD1RecoveryEpoch } from "./paired-d1-recovery.cf"
import {
  betterAuthD1ReleaseIdentity,
  cloudflarePlatformVersion,
  requiredReleaseIdentifier,
} from "./better-auth-d1-release-identity.cf"
import { assertOperatorSecretIsolation, operatorResponse } from "./better-auth-d1-operator.cf"

type RateLimitBinding = {
  limit(input: { key: string }): Promise<{ success: boolean }>
}

export type BetterAuthD1LockedWorkerEnv = {
  AUTH_DB: D1Database
  CONTROL_PLANE_DB: D1Database
  CLAXEDO_REQUEST_LIMITER: RateLimitBinding
  CLAXEDO_ADAPTER_PROFILE?: string
  CLAXEDO_PRODUCT_POSTURE?: string
  CLAXEDO_SANDBOX_POSTURE?: string
  CLAXEDO_SANDBOX_DRIVER?: string
  CLAXEDO_DEPLOYMENT_ID?: string
  CLAXEDO_RELEASE_SEQUENCE?: string
  CLAXEDO_RELEASE_ID?: string
  CLAXEDO_WORKER_BUILD_ID?: string
  CLAXEDO_AUTH_CONFIGURATION_ID?: string
  CLAXEDO_REQUEST_LIMITER_NAMESPACE_ID?: string
  CLAXEDO_RECOVERY_EPOCH?: string
  CLAXEDO_CANDIDATE_STATE_REVISION?: string
  CLAXEDO_CANDIDATE_OPERATION_ID?: string
  CLAXEDO_AUTH_METHODS?: string
  BETTER_AUTH_URL?: string
  CLAXEDO_APP_ORIGIN?: string
  BETTER_AUTH_SECRET?: string
  CLAXEDO_AUTH_INTROSPECTION_SECRET?: string
  CLAXEDO_RELEASE_OPERATOR_SECRET?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  CF_VERSION_METADATA?: { id?: string; tag?: string; timestamp?: string }
}

const authenticationByDatabase = new WeakMap<object, ReturnType<typeof createBetterAuthD1Foundation>>()

const requiredIdentifier = requiredReleaseIdentifier

async function releaseIdentity(
  env: BetterAuthD1LockedWorkerEnv,
  configured: ReturnType<typeof configuration>,
): Promise<DeploymentReleaseIdentity> {
  return await betterAuthD1ReleaseIdentity(env, configured, {
    browserBuildId: LOCKED_BROWSER_BUILD_ID,
    relayBuildId: LOCKED_RELAY_BUILD_ID,
    serviceManifestId: LOCKED_SERVICE_MANIFEST_ID,
  })
}

function configuration(env: BetterAuthD1LockedWorkerEnv) {
  return resolveBetterAuthConfiguration({
    env: {
      CLAXEDO_AUTH_METHODS: env.CLAXEDO_AUTH_METHODS,
      BETTER_AUTH_URL: env.BETTER_AUTH_URL,
      CLAXEDO_APP_ORIGIN: env.CLAXEDO_APP_ORIGIN,
      BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
      GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
      GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID,
      GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET,
    },
  })
}

function authentication(env: BetterAuthD1LockedWorkerEnv) {
  const existing = authenticationByDatabase.get(env.AUTH_DB as object)
  if (existing) return existing
  const configured = configuration(env)
  const created = createBetterAuthD1Foundation({
    database: env.AUTH_DB,
    configuration: configured,
    resource: betterAuthNativeResource(configured.public.apiOrigin),
  })
  authenticationByDatabase.set(env.AUTH_DB as object, created)
  return created
}

function json(request: Request, body: unknown, status: number, appOrigin?: string) {
  return secure(request, withCors(request, Response.json(body, { status }), appOrigin))
}

function withCors(request: Request, response: Response, appOrigin?: string) {
  if (appOrigin && request.headers.get("origin") === appOrigin) {
    const headers = new Headers(response.headers)
    headers.set("access-control-allow-origin", appOrigin)
    headers.set("access-control-allow-credentials", "true")
    headers.append("vary", "Origin")
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
  return response
}

function secure(request: Request, response: Response) {
  return withSecurityHeaders(
    response,
    securityHeaderEntries({
      https: requestIsHttps({ url: request.url, header: (name) => request.headers.get(name) ?? undefined }),
    }),
  )
}

function clientAddress(request: Request) {
  return request.headers.get("cf-connecting-ip") ?? "missing-client-address"
}

function platformVersion(env: BetterAuthD1LockedWorkerEnv) {
  return cloudflarePlatformVersion(env)
}

const handler = {
  async fetch(request: Request, env: BetterAuthD1LockedWorkerEnv): Promise<Response> {
    let identity: DeploymentReleaseIdentity
    let appOrigin: string | undefined
    try {
      if (!env.AUTH_DB || !env.CONTROL_PLANE_DB || typeof env.CLAXEDO_REQUEST_LIMITER?.limit !== "function") {
        throw new Error("required AUTH_DB, CONTROL_PLANE_DB, or CLAXEDO_REQUEST_LIMITER binding is missing")
      }
      assertOperatorSecretIsolation(env)
      const configured = configuration(env)
      identity = await releaseIdentity(env, configured)
      appOrigin = configured.public.appOrigin
      const rate = await env.CLAXEDO_REQUEST_LIMITER.limit({ key: `locked:${clientAddress(request)}` })
      if (!rate.success) return json(request, { error: { code: "rate_limited" } }, 429, appOrigin)
      const url = new URL(request.url)
      if (url.origin !== configured.public.apiOrigin) {
        throw new Error("observed request origin does not match BETTER_AUTH_URL")
      }
      const version = platformVersion(env)
      if (url.pathname === "/__release/candidate-health" && (request.method === "GET" || request.method === "HEAD")) {
        const candidate = await requireDeploymentReleaseCandidateAtRevision(
          env.AUTH_DB,
          identity,
          Number(requiredIdentifier(env.CLAXEDO_CANDIDATE_STATE_REVISION, "CLAXEDO_CANDIDATE_STATE_REVISION")),
          requiredIdentifier(env.CLAXEDO_CANDIDATE_OPERATION_ID, "CLAXEDO_CANDIDATE_OPERATION_ID"),
        )
        await requirePairedD1RecoveryEpoch(env.AUTH_DB, env.CONTROL_PLANE_DB, {
          deploymentId: identity.deploymentId,
          releaseId: identity.releaseId,
          recoveryEpoch: requiredIdentifier(env.CLAXEDO_RECOVERY_EPOCH, "CLAXEDO_RECOVERY_EPOCH"),
        })
        await requireBetterAuthDatabaseSchema(env.AUTH_DB)
        authentication(env)
        await requireBetterAuthNativeClientClosure(
          env.AUTH_DB,
          configured.public.apiOrigin,
          requiredIdentifier(env.BETTER_AUTH_SECRET, "BETTER_AUTH_SECRET"),
          requiredIdentifier(env.CLAXEDO_AUTH_INTROSPECTION_SECRET, "CLAXEDO_AUTH_INTROSPECTION_SECRET"),
        )
        return json(
          request,
          {
            status: "candidate-locked",
            platformVersionId: version.id,
            platformVersionTag: version.tag,
            release: {
              deploymentId: candidate.deploymentId,
              releaseId: candidate.releaseId,
              workerBuildId: candidate.workerBuildId,
              authConfigurationId: candidate.authConfigurationId,
              stateRevision: candidate.stateRevision,
            },
          },
          200,
          appOrigin,
        )
      }

      const release = await requireDeploymentReleaseState(env.AUTH_DB, identity)
      await requirePairedD1RecoveryEpoch(env.AUTH_DB, env.CONTROL_PLANE_DB, {
        deploymentId: identity.deploymentId,
        releaseId: identity.releaseId,
        recoveryEpoch: requiredIdentifier(env.CLAXEDO_RECOVERY_EPOCH, "CLAXEDO_RECOVERY_EPOCH"),
      })
      const operator = await operatorResponse(request, env, identity, appOrigin, url, { canBeginCanary: false })
      if (operator) return operator
      if (release.phase !== "locked" || release.phaseRevision !== 0 || release.firstTargetWriteAt !== null) {
        throw new Error(`locked Worker refuses persisted state ${release.phase}:${release.phaseRevision}`)
      }
      if (url.pathname === "/health" && (request.method === "GET" || request.method === "HEAD")) {
        authentication(env)
        await requireBetterAuthDatabaseSchema(env.AUTH_DB)
        await requireBetterAuthNativeClientClosure(
          env.AUTH_DB,
          configured.public.apiOrigin,
          requiredIdentifier(env.BETTER_AUTH_SECRET, "BETTER_AUTH_SECRET"),
          requiredIdentifier(env.CLAXEDO_AUTH_INTROSPECTION_SECRET, "CLAXEDO_AUTH_INTROSPECTION_SECRET"),
        )
        return json(
          request,
          {
            status: "locked",
            platformVersionId: version.id,
            platformVersionTag: version.tag,
            release: {
              deploymentId: release.deploymentId,
              releaseId: release.releaseId,
              workerBuildId: release.workerBuildId,
              browserBuildId: release.browserBuildId,
              relayBuildId: release.relayBuildId,
              authConfigurationId: release.authConfigurationId,
              stateRevision: release.stateRevision,
              phase: release.phase,
              phaseRevision: release.phaseRevision,
            },
            profile: {
              adapter: release.adapterProfile,
              product: release.productPosture,
              sandbox: release.sandboxPosture,
              services: release.serviceManifestId,
            },
          },
          200,
          appOrigin,
        )
      }

      if (request.method === "OPTIONS") {
        const origin = request.headers.get("origin")
        if (origin !== appOrigin) return secure(request, new Response(null, { status: 403 }))
        const response = new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": appOrigin,
            "access-control-allow-credentials": "true",
            "access-control-allow-methods": "GET, HEAD, OPTIONS",
            "access-control-allow-headers": "content-type, authorization",
            vary: "Origin",
          },
        })
        return secure(request, response)
      }

      if (
        url.pathname === "/.well-known/oauth-authorization-server" &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        const response = await oauthProviderAuthServerMetadata(authentication(env))(request)
        return secure(request, withCors(request, response, appOrigin))
      }
      return json(request, { error: { code: "deployment_locked" } }, 503, appOrigin)
    } catch (error) {
      console.error("[better-auth-d1-locked] deployment is unavailable", error)
      return json(request, { error: { code: "deployment_unavailable" } }, 503, appOrigin)
    }
  },
}

export default handler

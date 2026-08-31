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
import {
  USER_DEPLOYED_OWNER_CLAIM_HEADER,
  userDeployedOwnerIdentityHash,
} from "../../authority/adapters/d1/workspace-authority"
import type { HostedWorkerEnv } from "../../authority/provider-neutral-hosted-services"
import { resolveBetterAuthConfiguration } from "../../platform/auth/better-auth-configuration"
import {
  requireBetterAuthDatabaseSchema,
  requireBetterAuthNativeClientClosure,
} from "../../platform/auth/better-auth-native-clients"
import { createHostedCoreWorker, LiveSyncRoom, type HostedCoreWorkerEnv } from "./core-worker.cf"
import {
  admitDeploymentOperation,
  deploymentAdmissionBinding,
  recordDeploymentCanaryFirstWrite,
  requireDeploymentCanaryAdmission,
} from "./better-auth-d1-cutover-gate.cf"
import {
  betterAuthD1ReleaseIdentity,
  cloudflarePlatformVersion,
  requiredReleaseIdentifier,
  type BetterAuthD1ReleaseIdentityEnv,
} from "./better-auth-d1-release-identity.cf"
import {
  requireDeploymentReleaseCandidateAtRevision,
  requireDeploymentReleaseState,
} from "./better-auth-d1-release-state.cf"
import { requirePairedD1RecoveryEpoch } from "./paired-d1-recovery.cf"
import {
  assertOperatorSecretIsolation,
  operatorResponse,
  type BetterAuthD1OperatorEnv,
} from "./better-auth-d1-operator.cf"

export { LiveSyncRoom }

export type BetterAuthD1CandidateWorkerEnv = HostedCoreWorkerEnv &
  BetterAuthD1ReleaseIdentityEnv &
  BetterAuthD1OperatorEnv & {
    AUTH_DB: D1Database
    CONTROL_PLANE_DB: D1Database
    CLAXEDO_RECOVERY_EPOCH?: string
    CLAXEDO_BROWSER_BUILD_ID?: string
    CLAXEDO_RELAY_BUILD_ID?: string
    CLAXEDO_AUTH_DESCRIPTOR_EXPIRES_AT?: string
    CLAXEDO_ENVIRONMENT_ID?: string
    CLAXEDO_USER_DEPLOYED_ORGANIZATION_ID?: string
    CLAXEDO_USER_DEPLOYED_ORGANIZATION_NAME?: string
    CLAXEDO_CANARY_JOURNEY_ID?: string
    CLAXEDO_CANDIDATE_STATE_REVISION?: string
    CLAXEDO_CANDIDATE_OPERATION_ID?: string
    BETTER_AUTH_SECRET?: string
    CLAXEDO_AUTH_INTROSPECTION_SECRET?: string
  }

const compositionByEnvironment = new WeakMap<object, BetterAuthD1UserDeployedComposition>()

function stringEnvironment(env: BetterAuthD1CandidateWorkerEnv): HostedWorkerEnv {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function futureTimestamp(value: string | undefined, name: string) {
  const parsed = Number(requiredReleaseIdentifier(value, name))
  if (!Number.isFinite(parsed) || parsed <= Date.now()) throw new Error(`${name} must be a future finite timestamp`)
  return parsed
}

function composition(env: BetterAuthD1CandidateWorkerEnv) {
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

const core = createHostedCoreWorker<BetterAuthD1CandidateWorkerEnv>((env) => {
  const selected = composition(env)
  return { plane: selected.plane, options: selected.options }
})

function authRoute(pathname: string) {
  return (
    pathname === "/.well-known/oauth-authorization-server" ||
    pathname === "/api/auth" ||
    pathname.startsWith("/api/auth/")
  )
}

function authDescriptorRoute(pathname: string) {
  return pathname === "/api/claxedo/auth/descriptor"
}

function healthProbeRoute(pathname: string) {
  return pathname === "/api/claxedo/health"
}

function internalRelayRoute(pathname: string) {
  return pathname === "/internal/relay/target" || pathname === "/internal/relay/revocation"
}

function multiplayerAdmissionAuthenticationRequest(request: Request, pathname: string) {
  if (pathname !== "/api/runtime-authority/session-authorize" || !request.headers.has("authorization")) {
    return request
  }
  const headers = new Headers(request.headers)
  headers.delete("authorization")
  return new Request(request.clone(), { headers })
}

function unsafe(method: string) {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS"
}

const multiplayerValidationOperations = [
  "private_session",
  "stream",
  "revocation",
  "wrong_org",
  "replay",
  "outage",
] as const

function multiplayerValidationOperation(
  value: string | null,
): value is (typeof multiplayerValidationOperations)[number] {
  return multiplayerValidationOperations.some((candidate) => candidate === value)
}

function unavailable(request: Request, code = "deployment_candidate_unavailable") {
  return withSecurityHeaders(
    Response.json({ error: { code } }, { status: 503 }),
    securityHeaderEntries({
      https: requestIsHttps({ url: request.url, header: (name) => request.headers.get(name) ?? undefined }),
    }),
  )
}

function available(request: Request, body: unknown) {
  return withSecurityHeaders(
    Response.json(body, { status: 200 }),
    securityHeaderEntries({
      https: requestIsHttps({ url: request.url, header: (name) => request.headers.get(name) ?? undefined }),
    }),
  )
}

const handler = {
  async fetch(request: Request, env: BetterAuthD1CandidateWorkerEnv, context?: ExecutionContext) {
    try {
      if (!env.AUTH_DB || !env.CONTROL_PLANE_DB) throw new Error("AUTH_DB and CONTROL_PLANE_DB are required")
      assertOperatorSecretIsolation(env)
      const configured = resolveBetterAuthConfiguration({ env: stringEnvironment(env) })
      const url = new URL(request.url)
      if (url.origin !== configured.public.apiOrigin)
        throw new Error("observed request origin does not match BETTER_AUTH_URL")
      const identity = await betterAuthD1ReleaseIdentity(env, configured, {
        browserBuildId: requiredReleaseIdentifier(env.CLAXEDO_BROWSER_BUILD_ID, "CLAXEDO_BROWSER_BUILD_ID"),
        relayBuildId: requiredReleaseIdentifier(env.CLAXEDO_RELAY_BUILD_ID, "CLAXEDO_RELAY_BUILD_ID"),
        serviceManifestId: EMPTY_SERVICE_MANIFEST_ID,
      })
      const recovery = {
        deploymentId: identity.deploymentId,
        releaseId: identity.releaseId,
        recoveryEpoch: requiredReleaseIdentifier(env.CLAXEDO_RECOVERY_EPOCH, "CLAXEDO_RECOVERY_EPOCH"),
      }
      if (url.pathname === "/__release/candidate-health" && (request.method === "GET" || request.method === "HEAD")) {
        const candidate = await requireDeploymentReleaseCandidateAtRevision(
          env.AUTH_DB,
          identity,
          Number(requiredReleaseIdentifier(env.CLAXEDO_CANDIDATE_STATE_REVISION, "CLAXEDO_CANDIDATE_STATE_REVISION")),
          requiredReleaseIdentifier(env.CLAXEDO_CANDIDATE_OPERATION_ID, "CLAXEDO_CANDIDATE_OPERATION_ID"),
        )
        await requirePairedD1RecoveryEpoch(env.AUTH_DB, env.CONTROL_PLANE_DB, recovery)
        await requireBetterAuthDatabaseSchema(env.AUTH_DB)
        await requireBetterAuthNativeClientClosure(
          env.AUTH_DB,
          configured.public.apiOrigin,
          requiredReleaseIdentifier(env.BETTER_AUTH_SECRET, "BETTER_AUTH_SECRET"),
          requiredReleaseIdentifier(env.CLAXEDO_AUTH_INTROSPECTION_SECRET, "CLAXEDO_AUTH_INTROSPECTION_SECRET"),
        )
        composition(env)
        const version = cloudflarePlatformVersion(env)
        return available(request, {
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
        })
      }
      let release = await requireDeploymentReleaseState(env.AUTH_DB, identity)
      await requirePairedD1RecoveryEpoch(env.AUTH_DB, env.CONTROL_PLANE_DB, recovery)

      const operator = await operatorResponse(request, env, identity, configured.public.appOrigin, url, {
        canBeginCanary: true,
        expectedCanaryJourneyId: requiredReleaseIdentifier(
          env.CLAXEDO_CANARY_JOURNEY_ID,
          "CLAXEDO_CANARY_JOURNEY_ID",
        ),
      })
      if (operator) return operator
      if (url.pathname === "/health" && (request.method === "GET" || request.method === "HEAD")) {
        const version = cloudflarePlatformVersion(env)
        return available(request, {
          status: release.phase,
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
        })
      }
      const selected = composition(env)
      if (release.phase === "open") {
        if (authRoute(url.pathname)) return await selected.authHandler(request)
        return await core.fetch(request, env, context)
      }
      if (release.phase === "locked") {
        const journeyId = requiredReleaseIdentifier(env.CLAXEDO_CANARY_JOURNEY_ID, "CLAXEDO_CANARY_JOURNEY_ID")
        if (request.headers.get("x-claxedo-canary-journey-id") !== journeyId) {
          return unavailable(request, "deployment_phase_denied")
        }
        if (authRoute(url.pathname)) return await selected.authHandler(request)
        if (url.pathname === "/__release/canary/identity" && request.method === "GET") {
          const providerIdentity = await selected.verifyIdentity(request)
          return available(request, {
            identity: providerIdentity,
            identityHash: await userDeployedOwnerIdentityHash(providerIdentity),
          })
        }
        return unavailable(request, "deployment_phase_denied")
      }
      if (release.phase === "provider_sync") {
        return unavailable(request, "deployment_phase_denied")
      }
      if (release.phase === "multiplayer_validation") {
        // Browser OAuth bootstrap cannot carry the validation-operation
        // header through provider redirects, and a CORS preflight deliberately
        // carries no user credential. The shell's connection gate also probes
        // `/api/claxedo/health` before it mounts the login route, so requiring
        // an authenticated multiplayer receipt there creates an impossible
        // health-before-login cycle. These requests expose no product data:
        // the descriptor is a public deployment contract, the health route is
        // a public liveness probe, auth routes only establish an identity, and
        // OPTIONS is answered by the core CORS middleware. Every ordinary
        // product request remains identity- and operation-receipt-gated below.
        if (authDescriptorRoute(url.pathname) || healthProbeRoute(url.pathname)) {
          return await core.fetch(request, env, context)
        }
        if (request.method === "OPTIONS") {
          return authRoute(url.pathname)
            ? await selected.authHandler(request)
            : await core.fetch(request, env, context)
        }
        if (authRoute(url.pathname)) return await selected.authHandler(request)
      }
      if (authRoute(url.pathname)) {
        if (release.phase === "canary") {
          const admission = await requireDeploymentCanaryAdmission(env.AUTH_DB, identity)
          if (request.headers.get("x-claxedo-canary-journey-id") !== admission.journeyId) {
            return unavailable(request, "canary_journey_denied")
          }
        }
        return await selected.authHandler(request)
      }
      const claimPresent = request.headers.has(USER_DEPLOYED_OWNER_CLAIM_HEADER)
      if (claimPresent && !unsafe(request.method)) return unavailable(request, "bootstrap_owner_claim_method_denied")

      if (release.phase === "canary") {
        const admission = await requireDeploymentCanaryAdmission(env.AUTH_DB, identity)
        const canaryIdentityHash = admission.canaryIdentityHash
        const journeyId = admission.journeyId
        if (request.headers.get("x-claxedo-canary-journey-id") !== journeyId) {
          return unavailable(request, "canary_journey_denied")
        }
        const mutationOperationId = unsafe(request.method)
          ? requiredReleaseIdentifier(
              request.headers.get("x-claxedo-canary-mutation-operation-id") ?? undefined,
              "x-claxedo-canary-mutation-operation-id",
            )
          : undefined
        if (mutationOperationId && release.firstTargetWriteAt === null) {
          release = await recordDeploymentCanaryFirstWrite(env.AUTH_DB, identity, {
            binding: deploymentAdmissionBinding(release),
            operation: {
              kind: "canary_journey",
              canaryIdentityHash,
              journeyId,
              access: "mutation",
              mutationOperationId,
            },
          })
        }
        const principal = await selected.options.authentication.authenticate(request)
        if ((await userDeployedOwnerIdentityHash(principal.identity)) !== canaryIdentityHash) {
          return unavailable(request, "canary_identity_denied")
        }
        await admitDeploymentOperation(env.AUTH_DB, identity, {
          binding: deploymentAdmissionBinding(release),
          operation: {
            kind: "canary_journey",
            canaryIdentityHash,
            journeyId,
            access: unsafe(request.method) ? "mutation" : "read",
            ...(mutationOperationId ? { mutationOperationId } : {}),
          },
        })
        return await core.fetch(request, env, context)
      }

      // The deployed relay is part of the multiplayer-validation path, not a
      // browser actor. Its target and revocation probes authenticate at the
      // canonical internal routes with CLAXEDO_RELAY_RESOLVER_TOKEN, so they
      // cannot carry a user identity hash or one of the six browser operation
      // headers. Let the core route perform that service-token check; keeping
      // these probes behind user admission makes every real relay request fail
      // closed before the two-user journey can be exercised.
      if (internalRelayRoute(url.pathname)) return await core.fetch(request, env, context)

      const validationOperation = request.headers.get("x-claxedo-multiplayer-validation-operation")
      if (!multiplayerValidationOperation(validationOperation))
        return unavailable(request, "multiplayer_validation_operation_denied")
      if (url.pathname === "/__release/multiplayer/identity" && request.method === "GET") {
        const providerIdentity = await selected.verifyIdentity(request)
        const identityHash = await userDeployedOwnerIdentityHash(providerIdentity)
        // This is the release-bound discovery seam that gives the operator the
        // hash it must register. Receipt-gating it would require the hash to be
        // registered before the caller can learn it. The endpoint exposes only
        // the currently verified provider identity; every ordinary product
        // request below remains gated by admitDeploymentOperation.
        return available(request, { identity: providerIdentity, identityHash })
      }
      // Runtime-session requests carry a relay-host or stream-lease bearer
      // credential for the inner authority route while the multiplayer gate
      // authenticates the browser actor from its Better Auth cookie. Presenting
      // both to the control-plane authentication adapter is deliberately
      // rejected as ambiguous. Strip only the inner route's credential for the
      // outer admission check, then dispatch the original request so the
      // runtime authority still verifies the canonical bearer token and reads
      // the untouched request body.
      const principal = await selected.options.authentication.authenticate(
        multiplayerAdmissionAuthenticationRequest(request, url.pathname),
      )
      await admitDeploymentOperation(env.AUTH_DB, identity, {
        binding: deploymentAdmissionBinding(release),
        operation: {
          kind: "multiplayer_validation",
          operation: validationOperation,
          identityHash: await userDeployedOwnerIdentityHash(principal.identity),
        },
      })
      return await core.fetch(request, env, context)
    } catch (error) {
      console.error("[better-auth-d1-candidate] deployment is unavailable", error)
      return unavailable(request)
    }
  },
}

export default handler

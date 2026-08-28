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
import { createHostedCoreWorker, LiveSyncRoom, type HostedCoreWorkerEnv } from "./core-worker.cf"
import {
  admitDeploymentOperation,
  deploymentAdmissionBinding,
  recordDeploymentCanaryFirstWrite,
} from "./better-auth-d1-cutover-gate.cf"
import {
  betterAuthD1ReleaseIdentity,
  requiredReleaseIdentifier,
  type BetterAuthD1ReleaseIdentityEnv,
} from "./better-auth-d1-release-identity.cf"
import { requireDeploymentReleaseState } from "./better-auth-d1-release-state.cf"
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
    CLAXEDO_CANARY_IDENTITY_HASH?: string
    CLAXEDO_CANARY_JOURNEY_ID?: string
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
      let release = await requireDeploymentReleaseState(env.AUTH_DB, identity)
      await requirePairedD1RecoveryEpoch(env.AUTH_DB, env.CONTROL_PLANE_DB, {
        deploymentId: identity.deploymentId,
        releaseId: identity.releaseId,
        recoveryEpoch: requiredReleaseIdentifier(env.CLAXEDO_RECOVERY_EPOCH, "CLAXEDO_RECOVERY_EPOCH"),
      })

      const operator = await operatorResponse(request, env, identity, configured.public.appOrigin, url, {
        canBeginCanary: true,
      })
      if (operator) return operator
      if (release.phase === "open") return unavailable(request, "deployment_candidate_retired")
      const selected = composition(env)
      if (authRoute(url.pathname)) return await selected.authHandler(request)

      if (release.phase === "locked" || release.phase === "provider_sync") {
        return unavailable(request, "deployment_phase_denied")
      }
      const claimPresent = request.headers.has(USER_DEPLOYED_OWNER_CLAIM_HEADER)
      if (claimPresent && !unsafe(request.method)) return unavailable(request, "bootstrap_owner_claim_method_denied")

      if (release.phase === "canary") {
        const canaryIdentityHash = requiredReleaseIdentifier(
          env.CLAXEDO_CANARY_IDENTITY_HASH,
          "CLAXEDO_CANARY_IDENTITY_HASH",
        )
        const journeyId = requiredReleaseIdentifier(env.CLAXEDO_CANARY_JOURNEY_ID, "CLAXEDO_CANARY_JOURNEY_ID")
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

      const validationOperation = request.headers.get("x-claxedo-multiplayer-validation-operation")
      if (!multiplayerValidationOperation(validationOperation))
        return unavailable(request, "multiplayer_validation_operation_denied")
      const principal = await selected.options.authentication.authenticate(request)
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

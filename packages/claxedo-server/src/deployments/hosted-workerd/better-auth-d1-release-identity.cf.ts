import {
  betterAuthDeploymentConfigurationId,
  type BetterAuthConfiguration,
} from "../../platform/auth/better-auth-configuration"
import { resolveDeploymentProfileFromEnv } from "../hosted-shared/deployment-profile"
import type { DeploymentReleaseIdentity } from "./better-auth-d1-release-state.cf"

export type BetterAuthD1ReleaseIdentityEnv = {
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
  CF_VERSION_METADATA?: { id?: string; tag?: string; timestamp?: string }
}

export function requiredReleaseIdentifier(value: string | undefined, name: string) {
  if (!value?.trim()) throw new Error(`${name} is required`)
  return value.trim()
}

function requiredPositiveInteger(value: string | undefined, name: string) {
  const parsed = Number(value)
  if (!value?.trim() || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

export function cloudflarePlatformVersion(env: BetterAuthD1ReleaseIdentityEnv) {
  return {
    id: requiredReleaseIdentifier(env.CF_VERSION_METADATA?.id, "CF_VERSION_METADATA.id"),
    tag: requiredReleaseIdentifier(env.CF_VERSION_METADATA?.tag, "CF_VERSION_METADATA.tag"),
  }
}

/** Canonical release identity shared by the locked gate and open product root. */
export async function betterAuthD1ReleaseIdentity(
  env: BetterAuthD1ReleaseIdentityEnv,
  configured: BetterAuthConfiguration,
  artifacts: Readonly<{ browserBuildId: string; relayBuildId: string; serviceManifestId: string }>,
): Promise<DeploymentReleaseIdentity> {
  const profile = resolveDeploymentProfileFromEnv({
    CLAXEDO_ADAPTER_PROFILE: env.CLAXEDO_ADAPTER_PROFILE,
    CLAXEDO_PRODUCT_POSTURE: env.CLAXEDO_PRODUCT_POSTURE,
    CLAXEDO_SANDBOX_POSTURE: env.CLAXEDO_SANDBOX_POSTURE,
    CLAXEDO_SANDBOX_DRIVER: env.CLAXEDO_SANDBOX_DRIVER,
  })
  if (
    profile.adapterProfile !== "better-auth-d1" ||
    profile.productPosture !== "user-deployed" ||
    profile.sandboxPosture !== "control-plane-only"
  ) {
    throw new Error("the Better Auth D1 release certifies only user-deployed control-plane-only")
  }
  const authConfigurationId = await betterAuthDeploymentConfigurationId({
    methods: configured.public.methods,
    apiOrigin: configured.public.apiOrigin,
    appOrigin: configured.public.appOrigin,
    googleClientId: configured.private.socialProviders.google?.clientId,
    githubClientId: configured.private.socialProviders.github?.clientId,
  })
  if (
    requiredReleaseIdentifier(env.CLAXEDO_AUTH_CONFIGURATION_ID, "CLAXEDO_AUTH_CONFIGURATION_ID") !==
    authConfigurationId
  ) {
    throw new Error("CLAXEDO_AUTH_CONFIGURATION_ID does not match the live auth composition")
  }
  return {
    deploymentId: requiredReleaseIdentifier(env.CLAXEDO_DEPLOYMENT_ID, "CLAXEDO_DEPLOYMENT_ID"),
    releaseSequence: requiredPositiveInteger(env.CLAXEDO_RELEASE_SEQUENCE, "CLAXEDO_RELEASE_SEQUENCE"),
    releaseId: requiredReleaseIdentifier(env.CLAXEDO_RELEASE_ID, "CLAXEDO_RELEASE_ID"),
    workerBuildId: requiredReleaseIdentifier(env.CLAXEDO_WORKER_BUILD_ID, "CLAXEDO_WORKER_BUILD_ID"),
    platformVersionId: cloudflarePlatformVersion(env).id,
    browserBuildId: artifacts.browserBuildId,
    relayBuildId: artifacts.relayBuildId,
    authConfigurationId,
    requestLimiterNamespaceId: requiredReleaseIdentifier(
      env.CLAXEDO_REQUEST_LIMITER_NAMESPACE_ID,
      "CLAXEDO_REQUEST_LIMITER_NAMESPACE_ID",
    ),
    adapterProfile: profile.adapterProfile,
    productPosture: profile.productPosture,
    sandboxPosture: profile.sandboxPosture,
    serviceManifestId: artifacts.serviceManifestId,
  }
}

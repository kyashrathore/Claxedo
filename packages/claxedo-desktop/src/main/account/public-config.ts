import type { AccountConfigEnv } from "./account-config"

/** A deployment origin is public; provider/client configuration is descriptor-owned. */
export type BakedAccountConfig = {
  CLAXEDO_CORE_ORIGIN?: string
  CLAXEDO_RELEASE_VALIDATION_OPERATION?: string
  CLAXEDO_RELEASE_CANARY_JOURNEY_ID?: string
  CLAXEDO_RELAY_ORIGINS?: string
}

/**
 * This composer is an ALLOWLIST: whatever it does not name never reaches the
 * account config, no matter what the process environment holds. A release
 * phase input added to `AccountConfigEnv` must be added here too, or it is
 * silently dropped and the build behaves as if the phase were unset.
 *
 * A packaged build signs in only to the core origin it was built with: whoever
 * controls an installed app's launch environment is not choosing which
 * deployment receives the user's credentials.
 */
export function accountConfigEnvironment(
  runtime: AccountConfigEnv,
  baked: BakedAccountConfig,
  packaged: boolean,
): AccountConfigEnv {
  const runtimeCoreOrigin = packaged ? undefined : runtime.CLAXEDO_CORE_ORIGIN?.trim()
  return {
    CLAXEDO_CORE_ORIGIN: runtimeCoreOrigin || baked.CLAXEDO_CORE_ORIGIN?.trim() || undefined,
    CLAXEDO_RELEASE_VALIDATION_OPERATION:
      runtime.CLAXEDO_RELEASE_VALIDATION_OPERATION?.trim()
      || baked.CLAXEDO_RELEASE_VALIDATION_OPERATION?.trim()
      || undefined,
    CLAXEDO_RELEASE_CANARY_JOURNEY_ID:
      runtime.CLAXEDO_RELEASE_CANARY_JOURNEY_ID?.trim()
      || baked.CLAXEDO_RELEASE_CANARY_JOURNEY_ID?.trim()
      || undefined,
    CLAXEDO_RELAY_ORIGINS: runtime.CLAXEDO_RELAY_ORIGINS?.trim() || baked.CLAXEDO_RELAY_ORIGINS?.trim() || undefined,
  }
}

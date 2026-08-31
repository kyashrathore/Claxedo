import type { AccountConfigEnv } from "./account-config"

/** A deployment origin is public; provider/client configuration is descriptor-owned. */
export type BakedAccountConfig = {
  CLAXEDO_CORE_ORIGIN?: string
  CLAXEDO_RELEASE_VALIDATION_OPERATION?: string
}

export function accountConfigEnvironment(runtime: AccountConfigEnv, baked: BakedAccountConfig): AccountConfigEnv {
  return {
    CLAXEDO_CORE_ORIGIN: runtime.CLAXEDO_CORE_ORIGIN?.trim() || baked.CLAXEDO_CORE_ORIGIN?.trim() || undefined,
    CLAXEDO_RELEASE_VALIDATION_OPERATION:
      runtime.CLAXEDO_RELEASE_VALIDATION_OPERATION?.trim()
      || baked.CLAXEDO_RELEASE_VALIDATION_OPERATION?.trim()
      || undefined,
  }
}

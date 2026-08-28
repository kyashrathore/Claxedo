import type { AccountConfigEnv } from "./account-config"

/** A deployment origin is public; provider/client configuration is descriptor-owned. */
export type BakedAccountConfig = { CLAXEDO_CORE_ORIGIN?: string }

export function accountConfigEnvironment(runtime: AccountConfigEnv, baked: BakedAccountConfig): AccountConfigEnv {
  return {
    CLAXEDO_CORE_ORIGIN: runtime.CLAXEDO_CORE_ORIGIN?.trim() || baked.CLAXEDO_CORE_ORIGIN?.trim() || undefined,
  }
}

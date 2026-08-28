export type AccountConfigEnv = {
  /** The only desktop auth trust anchor. Provider details come from its descriptor. */
  CLAXEDO_CORE_ORIGIN?: string
}

export type AccountConfig = { configured: true; coreOrigin: string } | { configured: false; missing: string[] }

function exactHttpsOrigin(value: string | undefined) {
  const raw = value?.trim()
  if (!raw) return undefined
  try {
    const parsed = new URL(raw)
    if (
      parsed.protocol !== "https:" ||
      parsed.origin !== raw ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password ||
      parsed.hostname.includes("*")
    )
      return undefined
    return parsed.origin
  } catch {
    return undefined
  }
}

export function readAccountConfig(env: AccountConfigEnv): AccountConfig {
  const coreOrigin = exactHttpsOrigin(env.CLAXEDO_CORE_ORIGIN)
  return coreOrigin
    ? { configured: true, coreOrigin }
    : { configured: false, missing: ["coreOrigin (CLAXEDO_CORE_ORIGIN must be an exact HTTPS origin)"] }
}

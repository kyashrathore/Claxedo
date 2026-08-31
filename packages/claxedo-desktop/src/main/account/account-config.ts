export type AccountConfigEnv = {
  /** The only desktop auth trust anchor. Provider details come from its descriptor. */
  CLAXEDO_CORE_ORIGIN?: string
  /** Present only in a release-validation build; never a credential. */
  CLAXEDO_RELEASE_VALIDATION_OPERATION?: string
}

const releaseValidationOperations = [
  "private_session",
  "stream",
  "revocation",
  "wrong_org",
  "replay",
  "outage",
] as const

export type ReleaseValidationOperation = (typeof releaseValidationOperations)[number]

export type AccountConfig =
  | { configured: true; coreOrigin: string; releaseValidationOperation?: ReleaseValidationOperation }
  | { configured: false; missing: string[] }

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
  if (!coreOrigin) {
    return { configured: false, missing: ["coreOrigin (CLAXEDO_CORE_ORIGIN must be an exact HTTPS origin)"] }
  }
  const rawOperation = env.CLAXEDO_RELEASE_VALIDATION_OPERATION?.trim()
  const releaseValidationOperation = releaseValidationOperations.find((operation) => operation === rawOperation)
  if (rawOperation && !releaseValidationOperation) {
    return {
      configured: false,
      missing: ["releaseValidationOperation (CLAXEDO_RELEASE_VALIDATION_OPERATION is not recognized)"],
    }
  }
  return {
    configured: true,
    coreOrigin,
    ...(releaseValidationOperation ? { releaseValidationOperation } : {}),
  }
}

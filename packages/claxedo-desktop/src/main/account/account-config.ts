export type AccountConfigEnv = {
  /** The only desktop auth trust anchor. Provider details come from its descriptor. */
  CLAXEDO_CORE_ORIGIN?: string
  /** Present only in a release-validation build; never a credential. */
  CLAXEDO_RELEASE_VALIDATION_OPERATION?: string
  /**
   * Present only while driving a release's canary phase. The canary gate
   * admits exactly one journey, and a browser cannot set a header on its own
   * navigations, so a canary can only be exercised by a client told which
   * journey it belongs to. Not a credential: the gate still authenticates the
   * caller and checks the identity hash behind it.
   */
  CLAXEDO_RELEASE_CANARY_JOURNEY_ID?: string
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
  | {
      configured: true
      coreOrigin: string
      releaseValidationOperation?: ReleaseValidationOperation
      canaryJourneyId?: string
    }
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
  const canaryJourneyId = env.CLAXEDO_RELEASE_CANARY_JOURNEY_ID?.trim()
  return {
    configured: true,
    coreOrigin,
    ...(releaseValidationOperation ? { releaseValidationOperation } : {}),
    ...(canaryJourneyId ? { canaryJourneyId } : {}),
  }
}

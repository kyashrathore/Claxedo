import type { OnboardingDestination } from "./ai-connect-state"
import { isCloudRelevantCredential, isCloudShareable } from "./credential-sharing"
import { destinationIncludesCloud } from "./destination"

export type OnboardingSurface = "desktop" | "web" | "self-host"

export type CredentialVerification = "unverified" | "ok" | "auth_failed" | "no_billing" | "rate_capped" | "expired"

/**
 * A subscription sitting at its quota cap is authenticated — the provider
 * answered us, it just will not spend more until the window rolls over. Treating
 * that as unusable stranded anyone who hit their limit mid-setup: the AI step
 * could never complete, on an account that works fine an hour later.
 */
export function isUsableVerification(verification: CredentialVerification) {
  return verification === "ok" || verification === "rate_capped"
}

export type CredentialKind = "api_key" | "oauth_token" | "subscription_session" | "sandbox_driver"

type CredentialBase = {
  id: string
  providerId: string
  verification: CredentialVerification
  /**
   * What auth material this is. Optional because a server older than the field
   * omits it; every current server sends it on both credential routes.
   */
  kind?: CredentialKind
  /** How the credential was obtained. */
  source?: "managed" | "local_only" | "env" | "upstream_sync"
  /** Human name for this credential, e.g. "Claude Code login". */
  label?: string
  /** Disambiguates two credentials that share a label. */
  accountId?: string
  /** Unix ms when a rate-capped credential is expected to accept work again. */
  retryAt?: number
}

export type OnboardingCredential =
  | CredentialBase & { scope: "local"; machineId: string }
  | CredentialBase & { scope: "shared" }

export type OnboardingStateInput = {
  surface: OnboardingSurface
  machineId: string
  credentials: readonly OnboardingCredential[]
  runnableHarnesses: readonly string[]
  hasProject: boolean
  /**
   * Where the user said their agents will run. Undefined until they answer,
   * which keeps every cloud step absent rather than offered on a guess.
   */
  destination?: OnboardingDestination
  sandboxProviderConfigured: boolean
  /**
   * Whether a code host is connected that a sandbox could clone from. Cloud
   * sessions start from a repository, so a provider key alone does not make the
   * cloud usable.
   */
  codeHostConnected?: boolean
  hasFirstTurn: boolean
  hasFirstCloudTurn: boolean
  hostedSignedIn: boolean
  remoteAccessEnabled: boolean
  remoteAccessAvailable?: boolean
  remoteAccessLockedReason?: string
  secondDeviceOpen: boolean
}

export type OnboardingState = OnboardingStateInput & {
  /**
   * Whether this run has a cloud half at all. Every cloud step reads this
   * rather than `sandboxProviderConfigured`, which is what made the flow
   * circular: the provider step was hidden until the provider was configured.
   */
  wantsCloud: boolean
  /** A verified credential or a directly probed local harness can run an agent. */
  hasRunnableAI: boolean
  hasUsableCredential: boolean
  hasCredentialElsewhere: boolean
  credentialAvailability: "available" | "other-machine" | "none"
  /** Usable credentials that only this machine can reach and the cloud can keep working. */
  localOnlyCredentials: readonly OnboardingCredential[]
  /**
   * Machine-local credentials the cloud step must still show, but cannot offer.
   * A user whose only login is one of these has nothing to share, and needs to
   * be told why rather than shown an empty step.
   */
  unshareableCredentials: readonly OnboardingCredential[]
  hasCloudReadyCredential: boolean
}

export function onboardingState(input: OnboardingStateInput): OnboardingState {
  const verified = input.credentials.filter((credential) => isUsableVerification(credential.verification))
  const hasUsableCredential = verified.some(
    (credential) => credential.scope === "shared" || credential.machineId === input.machineId,
  )
  const hasCredentialElsewhere = verified.some(
    (credential) => credential.scope === "local" && credential.machineId !== input.machineId,
  )
  // Only credentials this machine holds can be pushed to the cloud; another
  // machine's local credential is not ours to share.
  const machineLocal = verified.filter(
    (credential) => credential.scope === "local" && credential.machineId === input.machineId,
  )
  const cloudRelevant = machineLocal.filter(isCloudRelevantCredential)
  const localOnlyCredentials = cloudRelevant.filter(isCloudShareable)
  const unshareableCredentials = cloudRelevant.filter((credential) => !isCloudShareable(credential))

  // A cloud turn that already happened is proof of intent that outranks a stale
  // or missing answer — a returning cloud user must not lose their cloud steps
  // because the question predates them.
  const wantsCloud = destinationIncludesCloud(input.destination) || input.hasFirstCloudTurn
  const hasRunnableAI = hasUsableCredential || (input.destination === "local" && input.runnableHarnesses.length > 0)

  return {
    ...input,
    wantsCloud,
    hasRunnableAI,
    hasUsableCredential,
    hasCredentialElsewhere,
    credentialAvailability: hasUsableCredential ? "available" : hasCredentialElsewhere ? "other-machine" : "none",
    localOnlyCredentials,
    unshareableCredentials,
    hasCloudReadyCredential: verified.some((credential) => credential.scope === "shared"),
  }
}

export type OnboardingSurface = "desktop" | "web" | "self-host"

export type CredentialVerification = "unverified" | "ok" | "auth_failed" | "no_billing" | "rate_capped" | "expired"

type CredentialBase = {
  id: string
  providerId: string
  verification: CredentialVerification
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
  sandboxProviderConfigured: boolean
  hasFirstTurn: boolean
  hasFirstCloudTurn: boolean
  hostedSignedIn: boolean
  remoteAccessEnabled: boolean
  remoteAccessAvailable?: boolean
  remoteAccessLockedReason?: string
  secondDeviceOpen: boolean
}

export type OnboardingState = OnboardingStateInput & {
  hasUsableCredential: boolean
  hasCredentialElsewhere: boolean
  credentialAvailability: "available" | "other-machine" | "none"
}

export function onboardingState(input: OnboardingStateInput): OnboardingState {
  const verified = input.credentials.filter((credential) => credential.verification === "ok")
  const hasUsableCredential = verified.some(
    (credential) => credential.scope === "shared" || credential.machineId === input.machineId,
  )
  const hasCredentialElsewhere = verified.some(
    (credential) => credential.scope === "local" && credential.machineId !== input.machineId,
  )

  return {
    ...input,
    hasUsableCredential,
    hasCredentialElsewhere,
    credentialAvailability: hasUsableCredential ? "available" : hasCredentialElsewhere ? "other-machine" : "none",
  }
}

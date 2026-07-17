import {
  applyCredentialResolution,
  resolveVerifiedCredentials,
  type AIVerificationResult,
  type CredentialResolvedModel,
} from "@/features/onboarding"
import type { HarnessId } from "@/platform/identity/session-ref"

export function applyAIConnectionResults(input: {
  results: AIVerificationResult[]
  providerDefaults: Readonly<Record<string, string | undefined>>
  setHarness: (harness: HarnessId) => void | Promise<void>
  setModel: (model: CredentialResolvedModel) => void | Promise<void>
}) {
  return applyCredentialResolution({
    resolution: resolveVerifiedCredentials({
      credentials: input.results.map((result) => ({ providerId: result.providerId, verification: result.result })),
      providerDefaults: input.providerDefaults,
    }),
    setHarness: input.setHarness,
    setModel: input.setModel,
  })
}

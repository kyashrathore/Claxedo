import { HARNESS_IDS, type HarnessId } from "@/platform/identity/session-ref"

export type CredentialResolvedModel = { providerID: string; modelID: string }

export type VerifiedCredentialInput = {
  providerId: string
  verification: "ok" | "auth_failed" | "no_billing" | "rate_capped" | "expired"
}

export type CredentialResolution = {
  runnableHarnesses: HarnessId[]
  defaultHarness: HarnessId | undefined
  defaultModel: CredentialResolvedModel | undefined
}

const anthropicProviders = ["anthropic", "claude-acp", "claude-sdk"]
const openAIProviders = ["openai"]
const codexProviders = ["openai-codex", "codex", "codex-acp", "codex-app-server"]
const cursorProviders = ["cursor", "cursor-acp", "cursor-sdk"]

export function resolveVerifiedCredentials(input: {
  credentials: readonly VerifiedCredentialInput[]
  providerDefaults: Readonly<Record<string, string | undefined>>
}): CredentialResolution {
  const verified = new Set(
    input.credentials.filter((item) => item.verification === "ok").map((item) => item.providerId),
  )
  const anthropic = [...verified].some((provider) => anthropicProviders.includes(provider))
  const openai = [...verified].some((provider) => openAIProviders.includes(provider))
  const codex = [...verified].some((provider) => codexProviders.includes(provider))
  const cursor = [...verified].some((provider) => cursorProviders.includes(provider))
  const runnable = new Set<HarnessId>()

  if (anthropic) {
    runnable.add("claude-acp")
    runnable.add("claude-sdk")
  }
  if (openai || codex) {
    runnable.add("codex-acp")
    runnable.add("codex-app-server")
    runnable.add("opencode")
  }
  if (cursor) {
    runnable.add("cursor-acp")
    runnable.add("cursor-sdk")
  }
  if (anthropic || openai || codex) runnable.add("pi")

  const preferred = openai
    ? { harness: "opencode" as const, providerID: "openai" }
    : codex
      ? { harness: "codex-app-server" as const, providerID: "openai-codex" }
      : anthropic
        ? { harness: "claude-sdk" as const, providerID: "anthropic" }
        : cursor
          ? { harness: "cursor-sdk" as const, providerID: "cursor" }
          : undefined
  const modelID = preferred ? input.providerDefaults[preferred.providerID] : undefined

  return {
    runnableHarnesses: HARNESS_IDS.filter((harness) => runnable.has(harness)),
    defaultHarness: preferred?.harness,
    defaultModel: preferred && modelID ? { providerID: preferred.providerID, modelID } : undefined,
  }
}

export async function applyCredentialResolution(input: {
  resolution: CredentialResolution
  setHarness: (harness: HarnessId) => void | Promise<void>
  setModel: (model: CredentialResolvedModel) => void | Promise<void>
}) {
  if (!input.resolution.defaultHarness || !input.resolution.defaultModel) return false
  await input.setHarness(input.resolution.defaultHarness)
  await input.setModel(input.resolution.defaultModel)
  return true
}

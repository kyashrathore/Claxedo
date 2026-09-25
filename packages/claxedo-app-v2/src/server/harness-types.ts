import type { HarnessSelection } from "../lib/harness-selection"

export type HarnessOptionChoice = { readonly id: string; readonly name: string; readonly description?: string; readonly connected?: boolean }

export type HarnessOptionSelect = { readonly choices: readonly HarnessOptionChoice[]; readonly current?: string }

export type HarnessOptionsSource = "harness" | "catalog" | "empty"

export type HarnessHealth = { readonly status?: "ok" | "degraded" | "unavailable"; readonly reason?: string }

export type HarnessConnectionState = { readonly connectionId: string; readonly state: "configured" | "connecting" | "ready" | "auth-required" | "disconnected" | "failed" }

export type HarnessState = {
  readonly type?: HarnessSelection
  readonly model?: string | null
  readonly modelProviderId?: string | null
  readonly thoughtLevel?: string
  readonly activeType?: HarnessSelection
  readonly status?: "configured" | "ready" | "applying" | "error"
  readonly error?: string
  readonly ready?: boolean
  readonly workspaceId?: string
  readonly harnessHealth?: HarnessHealth
  readonly connectionState?: HarnessConnectionState
}

export type SessionConfig = {
  readonly harness?: HarnessState
  readonly model: { readonly modelId: string | null; readonly providerId?: string | null } | null
  readonly variant?: string
}

export type HarnessLogin = { readonly harness: string; readonly signedIn: boolean; readonly providerIds: readonly string[] }

export type HarnessOptions = {
  readonly source: HarnessOptionsSource
  readonly stale: boolean
  readonly offersOptions: boolean
  readonly models?: HarnessOptionSelect
  readonly thoughtLevels?: HarnessOptionSelect
  readonly serviceTiers: readonly HarnessOptionChoice[]
  readonly resolvedModel?: HarnessOptionChoice
}

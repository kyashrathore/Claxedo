import type { ComposerNoticeTone } from "./notice-slot"
import type { HarnessConnectionState } from "@/server"

export type HarnessNoticeInput = {
  harnessLabel: string
  asleep?: boolean
  runtimeUnavailable: boolean
  connectionState?: HarnessConnectionState
  optionsFailed: boolean
  noModels: boolean
  configError?: string
  savedModelUnavailable?: string
  setupRequired?: boolean
  openProviders?: () => void
}

export type HarnessNotice = {
  kind: string
  tone: ComposerNoticeTone
  message: string
  detail?: string
  title?: string
  retry: boolean
  action?: { label: string; ariaLabel?: string; run: () => void }
}

const CONNECTION_NOTICES = {
  "auth-required": { tone: "critical", message: "requires authentication", detail: "Sign in to the agent or update this connection's credentials before trying again." },
  disconnected: { tone: "warning", message: "disconnected", detail: "The agent connection closed. Your transcript is saved; the next turn can reconnect." },
  failed: { tone: "critical", message: "connection failed", detail: "The agent connection could not be established. Check the connection settings before trying again." },
} as const satisfies Record<string, { tone: ComposerNoticeTone; message: string; detail: string }>

function connectionNotice(input: HarnessNoticeInput): HarnessNotice | undefined {
  const connection = input.connectionState?.state
  if (connection !== "auth-required" && connection !== "disconnected" && connection !== "failed") return undefined
  const notice = CONNECTION_NOTICES[connection]
  return { kind: `connection-${connection}`, tone: notice.tone, message: `${input.harnessLabel} ${notice.message}`, detail: notice.detail, retry: false }
}

function openModels(run: () => void) {
  return { label: "Open Models", ariaLabel: "Open Settings Models", run }
}

function asleepNotice(input: HarnessNoticeInput): HarnessNotice | undefined {
  if (!input.asleep || !(input.noModels || input.optionsFailed || input.runtimeUnavailable || input.setupRequired)) return undefined
  return { kind: "workspace-asleep", tone: "info", message: `${input.harnessLabel} models load when the workspace wakes`, detail: "Your next message wakes it.", retry: false }
}

export function resolveHarnessNotice(input: HarnessNoticeInput): HarnessNotice | undefined {
  const connection = connectionNotice(input)
  if (connection) return connection
  const asleep = asleepNotice(input)
  if (asleep) return asleep
  if (input.runtimeUnavailable) {
    return {
      kind: "runtime-unavailable",
      tone: "critical",
      message: `${input.harnessLabel} runtime is unavailable`,
      detail: input.configError ?? "It never finished starting. Retry, or pick another agent.",
      title: "Agent runtime unreachable after timeout",
      retry: true,
    }
  }
  if ((input.setupRequired || isProviderSetupError(input.configError)) && input.openProviders) {
    const detail = "Add an account in Settings → Models."
    return { kind: "setup-required", tone: "warning", message: `${input.harnessLabel} is not set up`, detail, retry: false, action: openModels(input.openProviders) }
  }
  if (input.optionsFailed || (input.configError && input.noModels)) {
    return { kind: "models-failed", tone: "critical", message: `Couldn't load ${input.harnessLabel} models`, detail: input.configError, retry: true }
  }
  if (!input.savedModelUnavailable) return undefined
  return {
    kind: "saved-model-unavailable",
    tone: "warning",
    message: `${input.savedModelUnavailable} is unavailable`,
    detail: "Reconnect its account in Settings → Models, or choose another model.",
    retry: false,
    ...(input.openProviders ? { action: openModels(input.openProviders) } : {}),
  }
}

function isProviderSetupError(error?: string) {
  return !!error && error.includes("cursor-sdk API key")
}

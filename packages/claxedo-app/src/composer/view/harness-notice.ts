import type { ComposerNoticeTone } from "./notice-slot"
import type { HarnessConnectionState } from "@/server"
import { accountUnavailableKind, type AccountUnavailable } from "../harness/options-state"

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
  accountRefused?: boolean
  accountUnavailable?: AccountUnavailable
  openProviders?: () => void
  unavailableHere?: { message: string; detail?: string; action?: { label: string; run: () => void } }
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

function setupRequiredNotice(label: string, open: () => void): HarnessNotice {
  return { kind: "setup-required", tone: "warning", message: `${label} is not set up`, detail: "Add an account in Settings → Models.", retry: false, action: openModels(open) }
}

function accountRefusedNotice(label: string, open: () => void): HarnessNotice {
  const detail = "Reconnect it in Settings → Models, or add another account."
  return { kind: "account-refused", tone: "warning", message: `${label}'s account was refused by its provider`, detail, retry: false, action: openModels(open) }
}

function accountUnavailableNotice(input: HarnessNoticeInput, account: AccountUnavailable, open: () => void): HarnessNotice {
  const label = input.harnessLabel
  const kind = accountUnavailableKind(account)
  if (kind === "not-set-up") return setupRequiredNotice(label, open)
  if (kind === "refused") return accountRefusedNotice(label, open)
  return { kind: "account-unusable", tone: "warning", message: `${label}'s account can't be used here`, detail: input.configError, retry: false, action: openModels(open) }
}

export function resolveHarnessNotice(input: HarnessNoticeInput): HarnessNotice | undefined {
  const connection = connectionNotice(input)
  if (connection) return connection
  if (input.asleep) return undefined
  if (input.unavailableHere) return { kind: "unavailable-here", tone: "warning", retry: false, ...input.unavailableHere }
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
  if ((input.setupRequired || isProviderSetupError(input.configError)) && input.openProviders) return setupRequiredNotice(input.harnessLabel, input.openProviders)
  if (input.accountUnavailable && input.openProviders) return accountUnavailableNotice(input, input.accountUnavailable, input.openProviders)
  if (input.accountRefused && input.openProviders) return accountRefusedNotice(input.harnessLabel, input.openProviders)
  if (input.optionsFailed || (input.configError && input.noModels)) {
    return { kind: "models-failed", tone: "critical", message: `Couldn't load ${input.harnessLabel} models`, detail: input.configError, retry: true }
  }
  if (!input.savedModelUnavailable) return undefined
  return {
    kind: "saved-model-unavailable",
    tone: "warning",
    message: `${input.harnessLabel} no longer offers ${input.savedModelUnavailable}`,
    detail: "Choose another model.",
    retry: false,
  }
}

function isProviderSetupError(error?: string) {
  return !!error && error.includes("cursor-sdk API key")
}

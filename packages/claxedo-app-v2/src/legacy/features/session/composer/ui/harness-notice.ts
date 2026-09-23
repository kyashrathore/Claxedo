// Collapses every harness failure state into at most one composer notice.
//
// Kept pure and separate from `AgentHarnessSelector` because the ordering is
// the whole point: these conditions overlap constantly — a dead runtime also
// fails option discovery, which also leaves the saved model unresolvable —
// and rendering each independently would stack "Unavailable ● Retry" in the
// same row.
import type { ComposerNoticeTone } from "./composer-notice"
import type { HarnessConnectionState } from "../../harness/profile"

export type HarnessNoticeInput = {
  /** Display name of the active harness, e.g. "Cursor". */
  harnessLabel: string
  /** Readiness settled on the terminal error state — the runtime never came up. */
  runtimeUnavailable: boolean
  connectionState?: HarnessConnectionState
  /** Model discovery failed and the list we hold is now stale. */
  optionsFailed: boolean
  /** No model options resolved at all. */
  noModels: boolean
  /** The runtime's own error text, unedited. */
  configError?: string
  /** Name of a saved default model that no longer resolves. */
  savedModelUnavailable?: string
  /** Credentials are missing and setup belongs in Settings → Providers. */
  setupRequired?: boolean
  openProviders?: () => void
}

export type HarnessNotice = {
  kind: string
  tone: ComposerNoticeTone
  message: string
  detail?: string
  title?: string
  /** Whether the row should offer a re-probe action. */
  retry: boolean
  action?: { label: string; ariaLabel?: string; run: () => void }
}

/**
 * `undefined` means "nothing worth a row" — including the merely-stale list,
 * which is a hint on the model control, not an error.
 */
export function resolveHarnessNotice(input: HarnessNoticeInput): HarnessNotice | undefined {
  const connection = input.connectionState?.state
  if (connection === "auth-required" || connection === "disconnected" || connection === "failed") {
    return {
      kind: `connection-${connection}`,
      tone: connection === "disconnected" ? "warning" : "critical",
      message: connection === "auth-required" ? `${input.harnessLabel} requires authentication`
        : connection === "disconnected" ? `${input.harnessLabel} disconnected` : `${input.harnessLabel} connection failed`,
      detail: connection === "auth-required" ? "Sign in to the agent or update this connection's credentials before trying again."
        : connection === "disconnected" ? "The agent connection closed. Your transcript is saved; the next turn can reconnect."
          : "The agent connection could not be established. Check the connection settings before trying again.",
      retry: false,
    }
  }
  // A dead runtime outranks everything downstream of it: every other failure
  // here is a symptom, and reporting the symptom sends the user to the wrong fix.
  if (input.runtimeUnavailable) {
    return {
      kind: "runtime-unavailable",
      tone: "critical",
      message: `${input.harnessLabel} runtime is unavailable`,
      detail: input.configError ?? "It never finished starting. Retry, or pick another agent.",
      // The harness e2e specs locate this state by this title string; changing it breaks them.
      title: "Agent runtime unreachable after timeout",
      retry: true,
    }
  }
  if ((input.setupRequired || isProviderSetupError(input.configError)) && input.openProviders) {
    return {
      kind: "setup-required",
      tone: "warning",
      message: `${input.harnessLabel} is not set up`,
      detail: "Add credentials in Settings → Providers.",
      retry: false,
      action: {
        label: "Open Providers",
        ariaLabel: "Open Settings Providers",
        run: input.openProviders,
      },
    }
  }
  const failure = input.configError
  if (input.optionsFailed || (failure && input.noModels)) {
    return {
      kind: "models-failed",
      tone: "critical",
      message: `Couldn't load ${input.harnessLabel} models`,
      detail: failure,
      retry: true,
    }
  }
  if (input.savedModelUnavailable) {
    return {
      kind: "saved-model-unavailable",
      tone: "warning",
      message: `${input.savedModelUnavailable} is unavailable`,
      detail: "Reconnect its provider in Settings → Providers, or choose another model.",
      retry: false,
      ...(input.openProviders ? {
        action: {
          label: "Open Providers",
          ariaLabel: "Open Settings Providers",
          run: input.openProviders,
        },
      } : {}),
    }
  }
  return undefined
}

function isProviderSetupError(error?: string) {
  return !!error && error.includes("cursor-sdk API key")
}

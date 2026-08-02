// Collapses every harness failure state into at most one composer notice.
//
// Kept pure and separate from `AgentHarnessSelector` because the ordering is
// the whole point: these conditions overlap constantly (a dead runtime also
// fails option discovery, which also leaves the saved model unresolvable), and
// the old UI rendered each one independently — which is exactly how the control
// row ended up showing "Unavailable ● Retry" all at once.
import type { ComposerNoticeTone } from "./composer-notice"

export type HarnessNoticeInput = {
  /** Display name of the active harness, e.g. "Cursor". */
  harnessLabel: string
  /** Readiness settled on the terminal error state — the runtime never came up. */
  runtimeUnavailable: boolean
  /** Model discovery failed and the list we hold is now stale. */
  optionsFailed: boolean
  /** No model options resolved at all. */
  noModels: boolean
  /** The runtime's own error text, verbatim. */
  configError?: string
  /** Provider-catalog error (pi only). */
  providerError?: string
  /** Name of a saved default model that no longer resolves. */
  savedModelUnavailable?: string
  /** A pi model is selected but has dropped out of the catalog. */
  piModelMissing: boolean
}

export type HarnessNotice = {
  kind: string
  tone: ComposerNoticeTone
  message: string
  detail?: string
  title?: string
  /** Whether the row should offer a re-probe action. */
  retry: boolean
}

/**
 * `undefined` means "nothing worth a row" — including the merely-stale list,
 * which is a hint on the model control, not an error.
 */
export function resolveHarnessNotice(input: HarnessNoticeInput): HarnessNotice | undefined {
  // A dead runtime outranks everything downstream of it: every other failure
  // here is a symptom, and reporting the symptom sends the user to the wrong fix.
  if (input.runtimeUnavailable) {
    return {
      kind: "runtime-unavailable",
      tone: "critical",
      message: `${input.harnessLabel} runtime is unavailable`,
      detail: input.configError ?? "It never finished starting. Retry, or pick another agent.",
      // The harness e2e specs locate this state by title; keep the string exact.
      title: "Agent runtime unreachable after timeout",
      retry: true,
    }
  }
  const failure = input.providerError ?? input.configError
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
      detail: "Reconnect its provider, or choose another model.",
      retry: false,
    }
  }
  if (input.piModelMissing) {
    return {
      kind: "pi-model-missing",
      tone: "warning",
      message: "This Pi model is no longer available",
      detail: "Choose another model.",
      retry: false,
    }
  }
  return undefined
}

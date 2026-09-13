import { HARNESS_CATALOG } from "@/platform/identity/harness-catalog"
export type AICredentialVerification = "ok" | "auth_failed" | "no_billing" | "rate_capped" | "expired"

/**
 * A rate-capped credential authenticated successfully — the provider answered,
 * it just will not spend more until the window resets. It counts as connected;
 * blocking on it stranded users who hit their quota mid-setup.
 */
export function isUsableResult(result: AICredentialVerification) {
  return result === "ok" || result === "rate_capped"
}

/** One quota window a subscription reports: `session`, `weekly`, `weekly_opus`, or a vendor slot. */
export type AIUsageWindow = { window: string; usedPercent: number; resetsAt: number | null }

/** What a live probe said about a candidate, before anything is saved. */
export type AIDiscoveryProbe =
  | { state: "working"; usage?: AIUsageWindow[] }
  | { state: "broken"; reason: string }
  | { state: "unknown"; reason: string }

export type AIDiscoveryItem = {
  providerId: string
  kind: string
  label: string
  accountId?: string
  origin: string
  freshUntil?: number
  alreadyConnected?: boolean
  probe?: AIDiscoveryProbe
}

/**
 * Where this user's agents will run. Set by the destination question; until that
 * ships, callers leave it unset and get `both`, which collects exactly as before.
 */
export type OnboardingDestination = "local" | "cloud" | "both"

/**
 * A local-only run stores nothing: the harness spawns the user's own binary and
 * inherits the login already on the machine. So the AI step's job is to confirm
 * a usable login exists, not to take a copy of one — a copy Claude Code would
 * rotate out from under us within hours.
 */
export function destinationStoresCredentials(destination: OnboardingDestination) {
  return destination !== "local"
}

/**
 * The harness bindings one Claude Code login is discovered under. Both are the
 * same credential; the registry keeps an entry per binding because each harness
 * resolves auth by its own provider id.
 */
export const claudeHarnessBindings = ["claude-acp", "claude-sdk"] as const

const connectionNames: Record<string, string> = {
  "claude-acp": "Claude Code login",
  "claude-sdk": "Claude Code login",
}

/** The name a settled row shows, so a verdict never reads as a raw provider id. */
export function connectionDisplayName(providerId: string) {
  return connectionNames[providerId] ?? providerId
}

/**
 * The harnesses a local run can use, in the order they are shown.
 *
 * Fixed rather than derived from what discovery returned: the local screen
 * answers "can I start working?", and a harness that is absent is exactly the
 * case the user needs told. Deriving the list would silently drop the row whose
 * absence is the answer.
 */
export const localHarnessChecks = [
  { id: "claude", label: HARNESS_CATALOG.claude.label, providerIds: claudeHarnessBindings, signIn: "claude" },
  { id: "codex", label: HARNESS_CATALOG.codex.label, providerIds: ["codex-app-server", "openai"], signIn: "codex login" },
  { id: "cursor", label: HARNESS_CATALOG.cursor.label, providerIds: ["cursor-acp"], signIn: "cursor-agent login" },
] as const

/**
 * What one harness on this computer says about the login it would run on.
 *
 * `state` is the harness's own answer, never a probe of ours: `signed_in` means
 * the CLI reports a login, not that we took a copy of one or spent a request
 * proving it. `absent` and `signed_out` are different answers to different
 * questions, and the repair differs — install it, or sign in to it.
 */
export type MachineLogin = {
  harness: string
  /** Every registry provider id this harness resolves its auth through. */
  providerIds: readonly string[]
  state: "signed_in" | "signed_out" | "absent" | "unknown"
  email?: string
  plan?: string
  org?: string
  /** Quota windows, for the harnesses that report them. Claude Code does not. */
  usage?: AIUsageWindow[]
  /** Why the harness could not be asked, when `state` is `unknown`. */
  detail?: string
}

export type LocalHarnessStatus = MachineLogin & {
  id: string
  label: string
  signIn: string
}

/**
 * One row per harness the local screen lists, in catalog order, carrying what
 * that harness said about itself.
 *
 * Fixed rather than derived from what the reports contain: the local screen
 * answers "can I start working?", and a harness that is absent is exactly the
 * case the user needs told.
 */
export function localHarnessStatuses(logins: readonly MachineLogin[]): LocalHarnessStatus[] {
  return localHarnessChecks.map((check) => {
    const login = logins.find((item) => item.harness === check.id)
    return {
      ...(login ?? { harness: check.id, providerIds: check.providerIds, state: "absent" as const }),
      id: check.id,
      label: check.label,
      signIn: check.signIn,
    }
  })
}

/** One discovered login, as it is offered for saving. */
export type AIDiscoveryRow = {
  selectionId: string
  providerId: string
  label: string
  accountId?: string
  origin: string
  alreadyConnected: boolean
  probe?: AIDiscoveryProbe
  selected: boolean
}

/**
 * Identity is what the credential IS — its provider and its account, the same
 * pair the save request addresses the item by, so a checked row and the
 * selection sent for it cannot drift apart.
 */
function selectionId(item: AIDiscoveryItem) {
  return `${item.providerId}\u0000${item.accountId ?? ""}`
}

export function discoveryRows(items: readonly AIDiscoveryItem[]): AIDiscoveryRow[] {
  return items.map((item) => {
    const alreadyConnected = item.alreadyConnected === true
    return {
      selectionId: selectionId(item),
      providerId: item.providerId,
      label: item.label,
      ...(item.accountId ? { accountId: item.accountId } : {}),
      origin: item.origin,
      alreadyConnected,
      ...(item.probe ? { probe: item.probe } : {}),
      selected: !alreadyConnected && item.probe?.state !== "broken",
    }
  })
}

/** The per-credential verdict rendered on its own row. */
export type AIConnectResult = {
  credentialId: string
  providerId: string
  result: AICredentialVerification
}

export type AIConnectState =
  | { phase: "idle" }
  | { phase: "discovering" }
  | { phase: "preview"; discoveryId: string; items: AIDiscoveryRow[] }
  | { phase: "saving" }
  /** Every credential in the batch has a verdict; none of them hides the others. */
  | { phase: "settled"; results: readonly AIConnectResult[] }
  /**
   * Local-only: what this machine can already run, with nothing written and
   * nothing read out of a harness's own store — each harness's own answer about
   * the login it would use.
   */
  | { phase: "confirmed"; logins: readonly MachineLogin[] }
  | { phase: "error"; message: string }

export type AIConnectEvent =
  | { type: "reset" }
  | { type: "discovery-started" }
  | { type: "discovery-succeeded"; discoveryId: string; items: AIDiscoveryItem[] }
  | { type: "machine-logins-read"; logins: readonly MachineLogin[] }
  | { type: "selection-changed"; selectionId: string; selected: boolean }
  | { type: "save-started" }
  | { type: "settled"; results: readonly AIConnectResult[] }
  | { type: "failed"; message: string }

export function initialAIConnectState(): AIConnectState {
  return { phase: "idle" }
}

export function aiConnectTransition(state: AIConnectState, event: AIConnectEvent): AIConnectState {
  if (event.type === "reset") return initialAIConnectState()
  if (event.type === "discovery-started") return { phase: "discovering" }
  if (event.type === "machine-logins-read") return { phase: "confirmed", logins: event.logins }
  if (event.type === "discovery-succeeded") {
    // Only credentials the provider actually accepted are pre-selected. A
    // broken one stays visible and unchecked with its reason — the user knows
    // it was found and why it was rejected, and can still override.
    return { phase: "preview", discoveryId: event.discoveryId, items: discoveryRows(event.items) }
  }
  if (event.type === "selection-changed" && state.phase === "preview") {
    return {
      ...state,
      items: state.items.map((item) => item.selectionId === event.selectionId && !item.alreadyConnected
        ? { ...item, selected: event.selected }
        : item),
    }
  }
  if (event.type === "save-started") return { phase: "saving" }
  if (event.type === "settled") return { phase: "settled", results: event.results }
  if (event.type === "failed") return { phase: "error", message: event.message }
  return state
}

export function aiConnectFailureCopy(result: AICredentialVerification) {
  if (result === "auth_failed") return "The provider rejected this credential. Reconnect or enter a new key."
  if (result === "no_billing") return "The credential was saved, but the provider reports that billing is not enabled."
  if (result === "rate_capped") return "At its usage limit right now — it will work again when the limit resets."
  if (result === "expired") return "This credential has expired. Reconnect to refresh it."
  return ""
}

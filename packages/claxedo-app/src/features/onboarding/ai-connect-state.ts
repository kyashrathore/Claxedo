export type AICredentialVerification = "ok" | "auth_failed" | "no_billing" | "rate_capped" | "expired"

export type AIDiscoveryItem = {
  providerId: string
  kind: string
  label: string
  accountId?: string
  origin: string
  freshUntil?: number
  alreadyConnected?: boolean
}

export type AIConnectState =
  | { phase: "idle" }
  | { phase: "discovering" }
  | { phase: "preview"; discoveryId: string; items: Array<AIDiscoveryItem & { selectionId: string; selected: boolean }> }
  | { phase: "saving" }
  | { phase: "verifying"; providerId: string }
  | { phase: "connected"; providerId: string }
  | { phase: "not-working"; providerId: string; result: Exclude<AICredentialVerification, "ok"> }
  | { phase: "error"; message: string }

export type AIConnectEvent =
  | { type: "reset" }
  | { type: "discovery-started" }
  | { type: "discovery-succeeded"; discoveryId: string; items: AIDiscoveryItem[] }
  | { type: "selection-changed"; selectionId: string; selected: boolean }
  | { type: "save-started" }
  | { type: "verification-started"; providerId: string }
  | { type: "verification-result"; result: AICredentialVerification }
  | { type: "failed"; message: string }

export function initialAIConnectState(): AIConnectState {
  return { phase: "idle" }
}

export function aiConnectTransition(state: AIConnectState, event: AIConnectEvent): AIConnectState {
  if (event.type === "reset") return initialAIConnectState()
  if (event.type === "discovery-started") return { phase: "discovering" }
  if (event.type === "discovery-succeeded") {
    return {
      phase: "preview",
      discoveryId: event.discoveryId,
      items: event.items.map((item, index) => ({
        ...item,
        selectionId: `${item.providerId}:${item.accountId ?? index}`,
        selected: !item.alreadyConnected,
      })),
    }
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
  if (event.type === "verification-started") return { phase: "verifying", providerId: event.providerId }
  if (event.type === "verification-result" && state.phase === "verifying") {
    if (event.result === "ok") return { phase: "connected", providerId: state.providerId }
    return { phase: "not-working", providerId: state.providerId, result: event.result }
  }
  if (event.type === "failed") return { phase: "error", message: event.message }
  return state
}

export function aiConnectFailureCopy(result: Exclude<AICredentialVerification, "ok">) {
  if (result === "auth_failed") return "The provider rejected this credential. Reconnect or enter a new key."
  if (result === "no_billing") return "The credential was saved, but the provider reports that billing is not enabled."
  if (result === "rate_capped") return "The provider rate limit is currently capped. Check the account limit, then retry."
  return "This credential has expired. Reconnect to refresh it."
}

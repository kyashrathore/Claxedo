import { createStore } from "solid-js/store"
import { decodeHarnessConnectionsCatalog, type HarnessConnectionsCatalog } from "@claxedo/agent-runtime-contract"
import { machine, unreachable, type Transition } from "@/lib/machine"
import type { ConnectionScope, IntegrationConnectOutcome, IntegrationFailure } from "@/server"

export function verifyFailedMessage(reason: unknown): string {
  if (reason === "unauthorized") return "The provided credentials were rejected. Check the values and try again."
  if (reason === "network") return "Could not reach the integration to verify the credentials. Try again."
  return "Verification failed. Try again."
}

export async function loadAgentConnections(): Promise<HarnessConnectionsCatalog> {
  const response = await fetch("/api/claxedo/agent-config/connections", { credentials: "include" })
  if (!response.ok) throw new Error(`Failed to load agent connections (${response.status})`)
  return decodeHarnessConnectionsCatalog(await response.json())
}

export async function removeAgentConnection(connectionId: string): Promise<void> {
  const response = await fetch(`/api/claxedo/agent-config/connections/${encodeURIComponent(connectionId)}`, { method: "DELETE", credentials: "include" })
  if (!response.ok) throw new Error(`Remove failed (${response.status})`)
}

export type ConnectState =
  | { readonly kind: "form"; readonly error?: string }
  | { readonly kind: "submitting"; readonly mode: "key" | "oauth" }
  | { readonly kind: "confirmReplace"; readonly mode: "key" | "oauth" }
  | { readonly kind: "oauthWaiting"; readonly url: string; readonly userCode?: string }
  | { readonly kind: "done" }

export type ConnectEvent =
  | { readonly type: "submit"; readonly mode: "key" | "oauth" }
  | { readonly type: "exists" }
  | { readonly type: "confirm" }
  | { readonly type: "cancel" }
  | { readonly type: "authorize"; readonly url: string; readonly userCode?: string }
  | { readonly type: "failed"; readonly error: string }
  | { readonly type: "connected" }

export const connectTransition: Transition<ConnectState, ConnectEvent> = (state, event) => {
  switch (event.type) {
    case "submit":
      return { kind: "submitting", mode: event.mode }
    case "exists":
      return state.kind === "submitting" ? { kind: "confirmReplace", mode: state.mode } : state
    case "confirm":
      return state.kind === "confirmReplace" ? { kind: "submitting", mode: state.mode } : state
    case "cancel":
      return { kind: "form" }
    case "authorize":
      return { kind: "oauthWaiting", url: event.url, ...(event.userCode ? { userCode: event.userCode } : {}) }
    case "failed":
      return { kind: "form", error: event.error }
    case "connected":
      return { kind: "done" }
    default:
      return unreachable(event)
  }
}

export const connectMachine = () => machine<ConnectState, ConnectEvent>({ kind: "form" }, connectTransition)

export type ConnectForm = {
  fields: Record<string, string>
  secret: string
  scope: ConnectionScope
}

export function createConnectForm(scope: ConnectionScope) {
  return createStore<ConnectForm>({ fields: {}, secret: "", scope })
}

export function connectError(outcome: Extract<IntegrationConnectOutcome, { kind: "failed" }>): string {
  if (outcome.code === "connection_verify_failed") return verifyFailedMessage(outcome.verifyReason)
  if (outcome.status === undefined) return outcome.reason === "unreachable" ? "Connect failed (unreachable)" : "The server did not return an authorization URL. Try again."
  return `Connect failed (${outcome.code ?? `status ${outcome.status}`})`
}

export function grantError(reason: IntegrationFailure): string {
  if (reason === "gone") return "The authorization attempt was not found or expired. Try again."
  if (reason === "expired") return "The authorization attempt expired. Try again."
  if (reason === "timeout") return "Timed out waiting for authorization. Try again."
  return "Authorization failed. Try again."
}

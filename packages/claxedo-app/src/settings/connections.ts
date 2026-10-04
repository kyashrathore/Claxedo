import { createStore } from "solid-js/store"
import { machine, unreachable, type Transition } from "@/lib/machine"
import type { ConnectionScope, IntegrationConnectOutcome, IntegrationFailure } from "@/server"

export function verifyFailedMessage(reason: unknown): string {
  if (reason === "unauthorized") return "The provided credentials were rejected. Check the values and try again."
  if (reason === "network") return "Could not reach the integration to verify the credentials. Try again."
  return "Verification failed. Try again."
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
  if (outcome.code === "connection_verify_failed" || outcome.code === "verify_failed") return verifyFailedMessage(outcome.verifyReason)
  if (outcome.reason === "unreachable") return "Could not reach Claxedo. Check your connection and try again."
  if (outcome.reason === "unoffered") return "Claxedo doesn't offer this integration here."
  if (outcome.reason === "rejected") return "The connection was refused. Check the values and try again."
  if (outcome.status === undefined) return "The sign-in page didn't open. Try again."
  return "Connecting failed. Try again."
}

export function grantError(reason: IntegrationFailure): string {
  if (reason === "gone") return "The authorization attempt was not found or expired. Try again."
  if (reason === "expired") return "The authorization attempt expired. Try again."
  if (reason === "timeout") return "Timed out waiting for authorization. Try again."
  return "Authorization failed. Try again."
}

const CAPABILITY_PURPOSE: Readonly<Record<string, string>> = {
  "code-host": "clone your repositories into cloud workspaces",
  "work-source": "read the issues you give them",
  docs: "read your documents",
  channel: "reach you in chat",
  mcp: "use its tools",
}

export function integrationPurpose(capabilities: readonly string[], locale: string): string | undefined {
  const phrases = capabilities.flatMap((capability) => {
    const phrase = CAPABILITY_PURPOSE[capability]
    return phrase ? [phrase] : []
  })
  if (phrases.length === 0) return undefined
  return `Lets agents ${new Intl.ListFormat(locale, { type: "conjunction" }).format(phrases)}.`
}

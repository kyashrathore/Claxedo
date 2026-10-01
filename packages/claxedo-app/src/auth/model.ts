import { machine, unreachable, type Transition } from "@/lib/machine"
import type { AppError } from "@/server"
import type { AuthUser } from "./display-user"

export type AuthState =
  | { readonly kind: "signedOut"; readonly reason?: string }
  | { readonly kind: "signingIn" }
  | { readonly kind: "signedIn"; readonly user: AuthUser }
  | { readonly kind: "expired" }

export type AuthEvent =
  | { readonly type: "started" }
  | { readonly type: "settled"; readonly user: AuthUser | null; readonly reason?: string }
  | { readonly type: "signedOut" }
  | { readonly type: "expired" }

export const authTransition: Transition<AuthState, AuthEvent> = (state, event) => {
  switch (event.type) {
    case "started":
      return { kind: "signingIn" }
    case "settled":
      return event.user
        ? { kind: "signedIn", user: event.user }
        : { kind: "signedOut", ...(event.reason ? { reason: event.reason } : {}) }
    case "signedOut":
      return { kind: "signedOut" }
    case "expired":
      return state.kind === "signedIn" ? { kind: "expired" } : state
    default:
      return unreachable(event)
  }
}

export const authMachine = (initial: AuthState) => machine<AuthState, AuthEvent>(initial, authTransition)

export type InvitationState =
  | { readonly kind: "idle" }
  | { readonly kind: "authenticating" }
  | { readonly kind: "accepting" }
  | { readonly kind: "joined"; readonly result: unknown }
  | { readonly kind: "failed"; readonly failure: AppError }

export type InvitationEvent =
  | { readonly type: "authenticationStarted" }
  | { readonly type: "acceptanceStarted" }
  | { readonly type: "accepted"; readonly result: unknown }
  | { readonly type: "authenticationPending" }
  | { readonly type: "failed"; readonly failure: AppError }

export const invitationTransition: Transition<InvitationState, InvitationEvent> = (_state, event) => {
  switch (event.type) {
    case "authenticationStarted":
      return { kind: "authenticating" }
    case "acceptanceStarted":
      return { kind: "accepting" }
    case "accepted":
      return { kind: "joined", result: event.result }
    case "authenticationPending":
      return { kind: "idle" }
    case "failed":
      return { kind: "failed", failure: event.failure }
    default:
      return unreachable(event)
  }
}

export const invitationMachine = () => machine<InvitationState, InvitationEvent>({ kind: "idle" }, invitationTransition)

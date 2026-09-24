import { machine, unreachable, type Transition } from "@/lib/machine"
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
      return event.user ? { kind: "signedIn", user: event.user } : { kind: "signedOut", ...(event.reason ? { reason: event.reason } : {}) }
    case "signedOut":
      return { kind: "signedOut" }
    case "expired":
      return state.kind === "signedIn" ? { kind: "expired" } : state
    default:
      return unreachable(event)
  }
}

export const authMachine = () => machine<AuthState, AuthEvent>({ kind: "signedOut" }, authTransition)

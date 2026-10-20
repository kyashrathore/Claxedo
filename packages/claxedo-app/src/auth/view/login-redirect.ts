import type { Accessor } from "solid-js"
import {
  loginDestination,
  loginOAuthContinuation,
  markAuthorizationSignInStarted,
  takeAuthorizationSignInStarted,
} from "../login-continuation"
import { appOrigin } from "../origins"

export type LoginLocation = { readonly pathname: string; readonly search: string; readonly hash: string }

export type LoginHost = {
  readonly location: Accessor<LoginLocation>
  readonly replaceWith: (path: string) => void
}

export type LoginRedirect = ReturnType<typeof loginRedirect>

export function loginRedirect(host: LoginHost) {
  const continuation = () => {
    const location = host.location()
    return loginOAuthContinuation({ origin: appOrigin(), pathname: location.pathname, search: location.search })
  }
  const freshSignInRequired = () => continuation()?.requiresFreshSignIn === true
  return {
    target: () => continuation()?.signInRedirect ?? "/",
    freshSignInRequired,
    started() {
      const current = continuation()
      if (current?.requiresFreshSignIn) markAuthorizationSignInStarted(current)
    },
    abandoned() {
      const current = continuation()
      if (current?.requiresFreshSignIn) takeAuthorizationSignInStarted(current)
    },
    finish() {
      const current = continuation()
      if (current?.requiresFreshSignIn && !takeAuthorizationSignInStarted(current)) return
      const destination = loginDestination(current)
      if ("assign" in destination) window.location.assign(destination.assign)
      else host.replaceWith(destination.navigate)
    },
  }
}

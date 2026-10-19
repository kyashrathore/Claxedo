import { useLocation, useNavigate } from "@solidjs/router"
import {
  loginDestination,
  loginOAuthContinuation,
  markAuthorizationSignInStarted,
  takeAuthorizationSignInStarted,
} from "../login-continuation"
import { apiOrigin, appOrigin } from "../origins"

export type LoginRedirect = ReturnType<typeof loginRedirect>

export function loginRedirect() {
  const location = useLocation()
  const navigate = useNavigate()
  const continuation = () =>
    loginOAuthContinuation({
      appOrigin: appOrigin(),
      apiOrigin: apiOrigin(),
      pathname: location.pathname,
      search: location.search,
    })
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
      else navigate(destination.navigate, { replace: true })
    },
  }
}

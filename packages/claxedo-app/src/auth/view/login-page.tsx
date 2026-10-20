import { useLocation, useNavigate } from "@solidjs/router"
import { Show } from "solid-js"
import { LoginForm } from "./login"
import type { LoginHost } from "./login-redirect"

function routerLoginHost(): LoginHost {
  const location = useLocation()
  const navigate = useNavigate()
  return {
    location: () => ({ pathname: location.pathname, search: location.search, hash: location.hash }),
    replaceWith: (path) => navigate(path, { replace: true }),
  }
}

export function LoginPage() {
  return <LoginForm host={routerLoginHost()} />
}

export function OrgInvitationPage() {
  const host = routerLoginHost()
  return (
    <Show when={host.location().hash.slice(1)} keyed fallback={
      <main class="auth-page">
        <section class="auth-card">
          <h1 class="auth-title">Invitation link is incomplete</h1>
          <p class="auth-subtitle">Open the complete invitation link from your email, or ask your organization for a new invitation.</p>
          <a class="auth-button" href="/">Continue to Claxedo</a>
        </section>
      </main>
    }>
      {(token) => <LoginForm host={host} invitationToken={token} />}
    </Show>
  )
}

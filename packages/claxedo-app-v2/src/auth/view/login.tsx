import { createSignal, For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import type { BrowserAuthMethod } from "../browser-auth"
import { loginOAuthContinuation } from "../login-continuation"
import { apiOrigin, appOrigin } from "../origins"
import { useAuth } from "../provider"
import "./auth.css"

const providerName = (method: "google" | "github") => (method === "google" ? "Google" : "GitHub")

export function LoginPage() {
  const navigate = useNavigate()
  const auth = useAuth()
  const [email, setEmail] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [failure, setFailure] = createSignal<string>()

  const continuation = () =>
    loginOAuthContinuation({ appOrigin: appOrigin(), apiOrigin: apiOrigin(), pathname: window.location.pathname, search: window.location.search })
  const redirectUrl = () => continuation()?.signInRedirect ?? "/"
  const signedRedirectUrl = () => continuation()?.authorizationUrl ?? "/"
  const busy = () => auth.state().kind === "signingIn"

  const finishSignedRedirect = () => {
    const destination = new URL(signedRedirectUrl(), appOrigin())
    if (destination.origin !== appOrigin()) {
      window.location.assign(destination.toString())
      return
    }
    navigate(`${destination.pathname}${destination.search}${destination.hash}`, { replace: true })
  }

  if (auth.state().kind === "signedIn") {
    finishSignedRedirect()
    return null
  }

  const continueWith = async (method?: BrowserAuthMethod) => {
    setFailure()
    try {
      await auth.signIn(
        method === "email-password"
          ? { method, email: email(), password: password(), redirectUrl: redirectUrl() }
          : method
            ? { method, redirectUrl: redirectUrl() }
            : { redirectUrl: redirectUrl() },
      )
      if (auth.state().kind === "signedIn") finishSignedRedirect()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Sign-in failed")
    }
  }

  const socialMethods = () =>
    auth.methods().filter((method): method is "google" | "github" => method === "google" || method === "github")

  return (
    <main class="auth-page" data-component="login-page">
      <section class="auth-card">
        <h1 class="auth-title">Claxedo</h1>
        <p class="auth-subtitle">Cloud-first development environment</p>
        <div class="auth-actions">
          <Show when={auth.methods().length === 0}>
            <button type="button" class="auth-button" disabled={busy()} onClick={() => void continueWith(undefined)}>
              {busy() ? "Redirecting…" : "Continue"}
            </button>
          </Show>
          <For each={socialMethods()}>
            {(method) => (
              <button type="button" class="auth-button" disabled={busy()} onClick={() => void continueWith(method)}>
                Continue with {providerName(method)}
              </button>
            )}
          </For>
          <Show when={auth.methods().includes("email-password")}>
            <form
              class="auth-form"
              onSubmit={(event) => {
                event.preventDefault()
                void continueWith("email-password")
              }}
            >
              <label class="auth-field">
                Email
                <input type="email" required autocomplete="email" value={email()} onInput={(event) => setEmail(event.currentTarget.value)} />
              </label>
              <label class="auth-field">
                Password
                <input type="password" required autocomplete="current-password" value={password()} onInput={(event) => setPassword(event.currentTarget.value)} />
              </label>
              <button type="submit" class="auth-button" disabled={busy()}>
                Sign in with email
              </button>
            </form>
          </Show>
          <Show when={failure() ?? auth.state().kind === "signedOut" ? auth.state().kind === "signedOut" && failure() : undefined}>
            {(message) => <p role="alert" class="auth-error">{message()}</p>}
          </Show>
          <Show when={auth.unavailable()}>
            {(reason) => <p class="auth-note">{reason()}</p>}
          </Show>
        </div>
      </section>
    </main>
  )
}

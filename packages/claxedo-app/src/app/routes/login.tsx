import { createSignal, For, onMount, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useAccountPort } from "@/platform/account/account-provider"
import { useAuthSession } from "@/platform/auth/auth-session"
import type { BrowserAuthMethod } from "@/platform/auth/browser-auth"

export interface LoginPageProps {
  /** App branding name (defaults to "Claxedo") */
  appName?: string
  /** App tagline (defaults to "Cloud-first development environment") */
  tagline?: string
  /** Success redirect URL (defaults to /) */
  redirectUrl?: string
  /** Custom terms of service URL */
  termsUrl?: string
  /** Custom privacy policy URL */
  privacyUrl?: string
}

/**
 * LoginPage component for Claxedo cloud authentication.
 * Uses the product account port. Hosted web renders only the methods selected
 * by its live auth descriptor; desktop binds Electron main, where the OAuth
 * credential stays.
 */
export default function LoginPage(props: LoginPageProps = {}) {
  const navigate = useNavigate()
  const account = useAccountPort()
  const auth = useAuthSession()
  const [redirecting, setRedirecting] = createSignal(false)
  const [email, setEmail] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [failure, setFailure] = createSignal<string>()

  const appName = () => props.appName ?? "Claxedo"
  const tagline = () => props.tagline ?? "Cloud-first development environment"
  const redirectUrl = () => props.redirectUrl ?? "/"

  onMount(async () => {
    if (account.state().status === "signed") {
      navigate(redirectUrl(), { replace: true })
      return
    }
  })

  if (account.state().status === "signed") {
    navigate(redirectUrl(), { replace: true })
    return null
  }

  const continueWith = async (method?: BrowserAuthMethod) => {
    setRedirecting(true)
    setFailure()
    // The destination rides on the call: the port's browser binding forwards
    // it into the provider redirect, and the /login e2e pins the argument.
    try {
      await account.signIn(
        method === "email-password"
          ? { method, email: email(), password: password(), redirectUrl: redirectUrl() }
          : method
            ? { method, redirectUrl: redirectUrl() }
            : { redirectUrl: redirectUrl() },
      )
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Sign-in failed")
    } finally {
      setRedirecting(false)
    }
  }

  const socialMethods = () =>
    auth.methods().filter((method): method is "google" | "github" => method === "google" || method === "github")
  const emailPasswordEnabled = () => auth.methods().includes("email-password")
  const genericContinue = () => auth.methods().length === 0 || auth.methods().includes("clerk")
  const providerName = (method: "google" | "github") => (method === "google" ? "Google" : "GitHub")

  return (
    <div class="flex flex-col items-center justify-center min-h-screen bg-background-base text-text-strong p-4">
      <div class="w-full max-w-md">
        <div class="text-center mb-8">
          <h1 class="text-3xl font-bold text-text-strong mb-2">{appName()}</h1>
          <p class="text-text-weak text-sm">{tagline()}</p>
        </div>

        <div class="space-y-3">
          <Show when={genericContinue()}>
            <button
              type="button"
              class="w-full rounded-lg bg-surface-interactive-base px-4 py-3 text-sm font-medium text-text-on-interactive-base transition hover:bg-surface-interactive-base/90 disabled:cursor-wait disabled:opacity-70"
              disabled={redirecting()}
              onClick={() => void continueWith(auth.methods().includes("clerk") ? "clerk" : undefined)}
            >
              <Show when={redirecting()} fallback="Continue">
                Redirecting...
              </Show>
            </button>
          </Show>

          <For each={socialMethods()}>
            {(method) => (
              <button
                type="button"
                class="w-full rounded-lg bg-surface-interactive-base px-4 py-3 text-sm font-medium text-text-on-interactive-base transition hover:bg-surface-interactive-base/90 disabled:cursor-wait disabled:opacity-70"
                disabled={redirecting()}
                onClick={() => void continueWith(method)}
              >
                Continue with {providerName(method)}
              </button>
            )}
          </For>

          <Show when={emailPasswordEnabled()}>
            <form
              class="space-y-3"
              onSubmit={(event) => {
                event.preventDefault()
                void continueWith("email-password")
              }}
            >
              <label class="block text-sm text-text-weak">
                Email
                <input
                  type="email"
                  required
                  autocomplete="email"
                  value={email()}
                  onInput={(event) => setEmail(event.currentTarget.value)}
                  class="mt-1 w-full rounded-lg border border-border-weak-base bg-background-base px-3 py-2 text-text-strong"
                />
              </label>
              <label class="block text-sm text-text-weak">
                Password
                <input
                  type="password"
                  required
                  autocomplete="current-password"
                  value={password()}
                  onInput={(event) => setPassword(event.currentTarget.value)}
                  class="mt-1 w-full rounded-lg border border-border-weak-base bg-background-base px-3 py-2 text-text-strong"
                />
              </label>
              <button
                type="submit"
                disabled={redirecting()}
                class="w-full rounded-lg bg-surface-interactive-base px-4 py-3 text-sm font-medium text-text-on-interactive-base disabled:cursor-wait disabled:opacity-70"
              >
                Sign in with email
              </button>
            </form>
          </Show>
          <Show when={failure()}>
            {(message) => (
              <p role="alert" class="text-sm text-icon-critical-base">
                {message()}
              </p>
            )}
          </Show>
        </div>

        <div class="mt-8 text-center text-xs text-text-weaker">
          By continuing, you agree to {appName()}'s{" "}
          <a href={props.termsUrl ?? "#"} class="text-text-interactive-base hover:underline">
            Terms of Service
          </a>{" "}
          and{" "}
          <a href={props.privacyUrl ?? "#"} class="text-text-interactive-base hover:underline">
            Privacy Policy
          </a>
          .
        </div>
      </div>
    </div>
  )
}

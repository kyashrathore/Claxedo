import { useLocation } from "@solidjs/router"
import { createEffect, createSignal, Show } from "solid-js"
import { handOffCliCallback, localCallback } from "../cli-callback"
import { cliCallbackFields, cliToken, userIdentity } from "../cli-login-token"
import { useAuth } from "../provider"
import "./auth.css"

type Status = "checking" | "redirecting" | "approving" | "error"

export function CliLoginPage() {
  const location = useLocation()
  const auth = useAuth()
  const [status, setStatus] = createSignal<Status>("checking")
  const [message, setMessage] = createSignal("Preparing CLI sign-in…")
  const [submitted, setSubmitted] = createSignal(false)

  const approve = async (callback: string, state: string) => {
    const access = auth.controlPlane
    const token = access.kind === "bearer" ? await access.token({ skipCache: true }) : null
    if (!token) throw new Error("No signed Claxedo session is available.")
    const exchanged = await cliToken(token)
    const fields = cliCallbackFields({
      state,
      accessToken: exchanged.accessToken,
      refreshToken: exchanged.refreshToken,
      tokenType: exchanged.tokenType,
      expiresIn: exchanged.expiresIn,
      identity: userIdentity(auth.user()),
    })
    handOffCliCallback({ callback, fields }, (path) => window.location.assign(path))
  }

  createEffect(() => {
    if (submitted()) return
    const params = new URLSearchParams(location.search)
    const callback = localCallback(params.get("callback"))
    const state = params.get("state")?.trim()
    if (!callback || !state) {
      setStatus("error")
      setMessage("Invalid CLI sign-in callback.")
      return
    }
    const kind = auth.state().kind
    if (kind === "signingIn") return
    if (kind !== "signedIn") {
      setStatus("redirecting")
      setMessage("Opening Claxedo sign-in…")
      void auth.signIn({ redirectUrl: window.location.href })
      return
    }
    setSubmitted(true)
    setStatus("approving")
    setMessage("Approving CLI sign-in…")
    void approve(callback, state).catch((error: unknown) => {
      setStatus("error")
      setMessage(error instanceof Error ? error.message : "CLI sign-in failed.")
    })
  })

  return (
    <main class="auth-page">
      <section class="auth-card auth-card-center">
        <div class="auth-title">Claxedo CLI</div>
        <p class="auth-subtitle">{message()}</p>
        <Show when={status() !== "error"}>
          <div class="auth-spinner" aria-hidden="true" />
        </Show>
      </section>
    </main>
  )
}

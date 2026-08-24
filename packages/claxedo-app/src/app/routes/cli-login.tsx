import { useLocation } from "@solidjs/router"
import { createTrackedEffect, createSignal, Show } from "solid-js"
import { useAuthSession } from "@/platform/auth/auth-session"
import { cliToken, localCallback, postToken, userIdentity } from "./cli-login-token"

export default function CliLoginPage() {
  const location = useLocation()
  const auth = useAuthSession()
  const [status, setStatus] = createSignal<"checking" | "redirecting" | "approving" | "error">("checking")
  const [message, setMessage] = createSignal("Preparing CLI sign-in...")
  const [submitted, setSubmitted] = createSignal(false)

  createTrackedEffect(() => {
    if (submitted()) return
    const params = new URLSearchParams(location.search)
    const callback = localCallback(params.get("callback"))
    const state = params.get("state")?.trim()
    if (!callback || !state) {
      setStatus("error")
      setMessage("Invalid CLI sign-in callback.")
      return
    }
    if (auth.status() === "loading") return
    if (auth.status() !== "signed") {
      setStatus("redirecting")
      setMessage("Opening Claxedo sign-in...")
      void auth.signIn({ redirectUrl: window.location.href })
      return
    }

    setSubmitted(true)
    setStatus("approving")
    setMessage("Approving CLI sign-in...")
    void auth
      .getToken({ skipCache: true })
      .then((token) => {
        if (!token) throw new Error("No signed Claxedo session is available.")
        return cliToken(token)
      })
      .then((token) => {
        postToken({
          callback,
          state,
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          tokenType: token.tokenType,
          expiresIn: token.expiresIn,
          identity: userIdentity(auth.user()),
        })
      })
      .catch((err) => {
        setStatus("error")
        setMessage(err instanceof Error ? err.message : "CLI sign-in failed.")
      })
  })

  return (
    <main class="min-h-dvh w-screen bg-background-base text-text-base grid place-items-center p-6">
      <section class="w-full max-w-sm text-center">
        <div class="text-16-medium text-text-strong">Claxedo CLI</div>
        <p class="mt-2 text-13-regular text-text-weak">{message()}</p>
        <Show when={status() !== "error"}>
          <div class="mx-auto mt-5 size-6 rounded-full border-2 border-border-base border-t-text-strong animate-spin" />
        </Show>
      </section>
    </main>
  )
}

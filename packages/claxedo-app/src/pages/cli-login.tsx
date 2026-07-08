import { useLocation } from "@solidjs/router"
import { createEffect, createSignal, Show } from "solid-js"
import { useAuthSession } from "../shell/auth/auth-session"
import { getClaxedoServerUrl } from "../utils/api"

function localCallback(input: string | null) {
  if (!input) return
  try {
    const url = new URL(input)
    if (url.protocol !== "http:") return
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") return
    return url.toString()
  } catch {
    return
  }
}

function userIdentity(input: unknown) {
  if (!input || typeof input !== "object") return "browser-session"
  const user = input as {
    id?: string
    fullName?: string | null
    primaryEmailAddress?: { emailAddress?: string | null } | null
  }
  return user.primaryEmailAddress?.emailAddress ?? user.fullName ?? user.id ?? "browser-session"
}

function text(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

function number(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

async function cliToken(browserToken: string) {
  const response = await fetch(`${getClaxedoServerUrl()}/api/auth/cli/exchange`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${browserToken}`,
    },
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const error = body && typeof body === "object" && "error" in body ? (body.error as Record<string, unknown>) : undefined
    throw new Error(text(error?.message) ?? "CLI token exchange failed.")
  }
  if (!body || typeof body !== "object") throw new Error("CLI token exchange returned an invalid response.")
  const row = body as Record<string, unknown>
  const accessToken = text(row.access_token) ?? text(row.accessToken)
  if (!accessToken) throw new Error("CLI token exchange did not return an access token.")
  return {
    accessToken,
    refreshToken: text(row.refresh_token) ?? text(row.refreshToken),
    tokenType: text(row.token_type) ?? text(row.tokenType),
    expiresIn: number(row.expires_in) ?? number(row.expiresIn),
  }
}

function postToken(input: {
  callback: string
  state: string
  accessToken: string
  identity: string
  refreshToken?: string
  tokenType?: string
  expiresIn?: number
}) {
  const form = document.createElement("form")
  form.method = "POST"
  form.action = input.callback
  form.style.display = "none"
  for (const [name, value] of Object.entries({
    state: input.state,
    access_token: input.accessToken,
    identity: input.identity,
    ...(input.refreshToken ? { refresh_token: input.refreshToken } : {}),
    ...(input.tokenType ? { token_type: input.tokenType } : {}),
    ...(input.expiresIn ? { expires_in: String(input.expiresIn) } : {}),
  })) {
    const field = document.createElement("input")
    field.type = "hidden"
    field.name = name
    field.value = value
    form.appendChild(field)
  }
  document.body.appendChild(form)
  form.submit()
}

export default function CliLoginPage() {
  const location = useLocation()
  const auth = useAuthSession()
  const [status, setStatus] = createSignal<"checking" | "redirecting" | "approving" | "error">("checking")
  const [message, setMessage] = createSignal("Preparing CLI sign-in...")
  const [submitted, setSubmitted] = createSignal(false)

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
    void auth.getToken({ skipCache: true })
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

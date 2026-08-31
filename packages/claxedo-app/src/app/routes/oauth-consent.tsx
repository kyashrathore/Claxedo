import { createSignal, For, Show } from "solid-js"

type ConsentResponse = {
  redirect?: unknown
  url?: unknown
  error?: { message?: unknown }
}

export type OAuthConsentSubmission = {
  accept: boolean
  oauthQuery: string
}

export async function submitOAuthConsent(
  input: OAuthConsentSubmission,
  request: typeof fetch,
  apiOrigin: string,
) {
  const response = await request(new URL("/api/auth/oauth2/consent", apiOrigin).toString(), {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accept: input.accept, oauth_query: input.oauthQuery }),
  })
  const body = (await response.json().catch(() => undefined)) as ConsentResponse | undefined
  if (!response.ok) {
    const message = typeof body?.error?.message === "string" ? body.error.message : `Consent failed (${response.status})`
    throw new Error(message)
  }
  if (body?.redirect !== true || typeof body.url !== "string") {
    throw new Error("Authorization server did not return a consent redirect")
  }
  const destination = new URL(body.url)
  if ((destination.protocol !== "http:" && destination.protocol !== "https:") || destination.username || destination.password) {
    throw new Error("Authorization server returned an invalid consent redirect")
  }
  return destination.toString()
}

function requestedScopes(search: string) {
  return (new URLSearchParams(search).get("scope") ?? "")
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean)
}

export default function OAuthConsentPage(props: {
  request: typeof fetch
  apiOrigin: string
  submit?: (input: OAuthConsentSubmission) => Promise<string>
  redirect?: (url: string) => void
}) {
  const [submitting, setSubmitting] = createSignal<"allow" | "deny">()
  const [failure, setFailure] = createSignal<string>()
  const query = () => window.location.search
  const scopes = () => requestedScopes(query())
  const redirect = props.redirect ?? ((url: string) => window.location.assign(url))

  const decide = async (accept: boolean) => {
    setSubmitting(accept ? "allow" : "deny")
    setFailure()
    try {
      const destination = await (props.submit ?? ((input) => submitOAuthConsent(input, props.request, props.apiOrigin)))({
        accept,
        oauthQuery: query(),
      })
      redirect(destination)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Consent failed")
      setSubmitting()
    }
  }

  return (
    <main class="flex min-h-screen items-center justify-center bg-background-base p-4 text-text-strong">
      <section class="w-full max-w-md rounded-xl border border-border-weak-base bg-surface-base p-6 shadow-lg">
        <p class="mb-2 text-xs font-medium uppercase tracking-wide text-text-weaker">Desktop authorization</p>
        <h1 class="mb-2 text-2xl font-semibold">Allow Claxedo Desktop?</h1>
        <p class="mb-5 text-sm text-text-weak">
          The desktop app is requesting access to your Claxedo workspaces on this deployment.
        </p>

        <Show when={scopes().length > 0}>
          <div class="mb-6 rounded-lg border border-border-weak-base bg-background-base p-4">
            <p class="mb-2 text-xs font-medium text-text-weaker">Requested permissions</p>
            <ul class="space-y-1 text-sm text-text-weak">
              <For each={scopes()}>{(scope) => <li>{scope}</li>}</For>
            </ul>
          </div>
        </Show>

        <Show when={failure()}>
          {(message) => <p role="alert" class="mb-4 text-sm text-icon-critical-base">{message()}</p>}
        </Show>

        <div class="flex justify-end gap-3">
          <button
            type="button"
            class="rounded-lg border border-border-weak-base px-4 py-2 text-sm font-medium text-text-weak disabled:cursor-wait disabled:opacity-60"
            disabled={submitting() !== undefined}
            onClick={() => void decide(false)}
          >
            {submitting() === "deny" ? "Cancelling..." : "Cancel"}
          </button>
          <button
            type="button"
            class="rounded-lg bg-surface-interactive-base px-4 py-2 text-sm font-medium text-text-on-interactive-base disabled:cursor-wait disabled:opacity-60"
            disabled={submitting() !== undefined}
            onClick={() => void decide(true)}
          >
            {submitting() === "allow" ? "Allowing..." : "Allow"}
          </button>
        </div>
      </section>
    </main>
  )
}

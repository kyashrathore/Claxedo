import { createResource, createSignal, For, Show, Suspense } from "solid-js"
import { readBoolean, readString } from "@/lib/record"
import { betterAuthApiError } from "@/platform/auth/better-auth-api-error"

export type OAuthConsentSubmission = {
  accept: boolean
  oauthQuery: string
  /** The subset the user granted, space-separated; absent accepts everything the client asked for. */
  scope?: string
}

export type OAuthConsentClient = {
  clientId: string
  name?: string
  uri?: string
}

/**
 * The scopes the MCP endpoint reads, in the order consent shows them.
 *
 * Every other requested scope is part of a Claxedo-registered app's own
 * sign-in (`openid`, `workspace:write`, …) and is granted whole: subsetting
 * those is how a desktop that "signed in" ends up unable to open a workspace.
 */
const MCP_CONSENT_SCOPES = [
  { scope: "claxedo:read", label: "Read sessions, workspaces and what needs you" },
  { scope: "claxedo:act", label: "Start sessions and send prompts" },
  { scope: "claxedo:approve", label: "Answer permission prompts on your behalf" },
  { scope: "claxedo:admin", label: "Create and destroy workspaces" },
] as const

const MCP_CONSENT_DEFAULTS = ["claxedo:read", "claxedo:act"] as const

/**
 * The client ids this deployment registers itself, in
 * `better-auth-native-clients.ts`. Every other client arrived through RFC 7591
 * dynamic registration, where the authorization server — not the registrant —
 * mints the id, so no MCP host can present itself as one of these.
 */
const DEPLOYMENT_REGISTERED_CLIENT_IDS = ["claxedo-cli", "claxedo-desktop"] as const

export async function readOAuthConsentClient(
  clientId: string,
  request: typeof fetch,
  apiOrigin: string,
): Promise<OAuthConsentClient> {
  const url = new URL("/api/auth/oauth2/public-client", apiOrigin)
  url.searchParams.set("client_id", clientId)
  const response = await request(url.toString(), { credentials: "include", headers: { accept: "application/json" } })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    throw betterAuthApiError(body, response.status, "Could not identify the requesting application")
  }
  const name = readString(body, "client_name")
  const uri = readString(body, "client_uri")
  return { clientId, ...(name ? { name } : {}), ...(uri ? { uri } : {}) }
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
    body: JSON.stringify({
      accept: input.accept,
      oauth_query: input.oauthQuery,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
    }),
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) throw betterAuthApiError(body, response.status, "Consent failed")
  const url = readString(body, "url")
  if (readBoolean(body, "redirect") !== true || url === undefined) {
    throw new Error("Authorization server did not return a consent redirect")
  }
  const destination = new URL(url)
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

/** The MCP scopes on offer: those the client asked for, minus admin unless this deployment registered it. */
export function offeredMcpScopes(scopes: readonly string[], clientId: string | undefined) {
  const requested = new Set(scopes)
  return MCP_CONSENT_SCOPES.filter((entry) => {
    if (!requested.has(entry.scope)) return false
    if (entry.scope !== "claxedo:admin") return true
    return clientId !== undefined && (DEPLOYMENT_REGISTERED_CLIENT_IDS as readonly string[]).includes(clientId)
  })
}

export default function OAuthConsentPage(props: {
  request: typeof fetch
  apiOrigin: string
  loadClient?: (clientId: string) => Promise<OAuthConsentClient>
  submit?: (input: OAuthConsentSubmission) => Promise<string>
  redirect?: (url: string) => void
}) {
  const [submitting, setSubmitting] = createSignal<"allow" | "deny">()
  const [failure, setFailure] = createSignal<string>()
  const query = () => window.location.search
  const scopes = () => requestedScopes(query())
  const clientId = () => new URLSearchParams(query()).get("client_id")?.trim() || undefined
  const redirect = props.redirect ?? ((url: string) => window.location.assign(url))
  const loadClient = props.loadClient
    ?? ((id: string) => readOAuthConsentClient(id, props.request, props.apiOrigin))

  const [client] = createResource(clientId, loadClient)

  const offered = () => offeredMcpScopes(scopes(), clientId())
  const carried = () => scopes().filter((scope) => !MCP_CONSENT_SCOPES.some((entry) => entry.scope === scope))
  const [granted, setGranted] = createSignal<ReadonlySet<string>>(new Set(MCP_CONSENT_DEFAULTS))

  const toggle = (scope: string, on: boolean) => {
    setGranted((current) => {
      const next = new Set(current)
      if (on) next.add(scope)
      else next.delete(scope)
      return next
    })
  }

  const decide = async (accept: boolean) => {
    setSubmitting(accept ? "allow" : "deny")
    setFailure()
    const offeredScopes = offered().map((entry) => entry.scope)
    const grant = [...carried(), ...offeredScopes.filter((scope) => granted().has(scope))]
    try {
      const destination = await (props.submit ?? ((input) => submitOAuthConsent(input, props.request, props.apiOrigin)))({
        accept,
        oauthQuery: query(),
        // Only ever narrows: an unoffered scope cannot enter `grant`, so a
        // client that asked for `claxedo:admin` without being one this
        // deployment registered is granted the request without it.
        ...(offeredScopes.length > 0 ? { scope: grant.join(" ") } : {}),
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
        <p class="mb-2 text-xs font-medium uppercase tracking-wide text-text-weaker">Authorization request</p>
        <Suspense fallback={<h1 class="mb-2 text-2xl font-semibold">Allow this application?</h1>}>
          <h1 class="mb-2 text-2xl font-semibold" data-testid="consent-client">
            Allow {client()?.name ?? clientId() ?? "this application"}?
          </h1>
        </Suspense>
        <p class="mb-5 text-sm text-text-weak">
          It is requesting access to your Claxedo workspaces on this deployment.
        </p>

        <Show when={offered().length > 0}>
          <fieldset class="mb-6 rounded-lg border border-border-weak-base bg-background-base p-4">
            <legend class="px-1 text-xs font-medium text-text-weaker">Choose what it may do</legend>
            <For each={offered()}>
              {(entry) => (
                <label class="flex items-start gap-3 py-1 text-sm text-text-weak">
                  <input
                    type="checkbox"
                    class="mt-1"
                    checked={granted().has(entry.scope)}
                    onChange={(event) => toggle(entry.scope, event.currentTarget.checked)}
                  />
                  <span>{entry.label}</span>
                </label>
              )}
            </For>
          </fieldset>
        </Show>

        <Show when={carried().length > 0}>
          <div class="mb-6 rounded-lg border border-border-weak-base bg-background-base p-4">
            <p class="mb-2 text-xs font-medium text-text-weaker">Requested permissions</p>
            <ul class="space-y-1 text-sm text-text-weak">
              <For each={carried()}>{(scope) => <li>{scope}</li>}</For>
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

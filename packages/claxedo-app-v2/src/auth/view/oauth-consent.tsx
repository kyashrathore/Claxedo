import { createResource, createSignal, For, Show } from "solid-js"
import {
  MCP_CONSENT_DEFAULTS,
  carriedScopes,
  offeredMcpScopes,
  readOAuthConsentClient,
  requestedScopes,
  submitOAuthConsent,
} from "../oauth-consent"
import "./auth.css"

export function OAuthConsentPage() {
  const [submitting, setSubmitting] = createSignal<"allow" | "deny">()
  const [failure, setFailure] = createSignal<string>()
  const query = () => window.location.search
  const scopes = () => requestedScopes(query())
  const clientId = () => new URLSearchParams(query()).get("client_id")?.trim() || undefined
  const [client] = createResource(clientId, readOAuthConsentClient)
  const offered = () => offeredMcpScopes(scopes(), clientId())
  const carried = () => carriedScopes(scopes())
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
      const destination = await submitOAuthConsent({
        accept,
        oauthQuery: query(),
        ...(offeredScopes.length > 0 ? { scope: grant.join(" ") } : {}),
      })
      window.location.assign(destination)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Consent failed")
      setSubmitting()
    }
  }

  return (
    <main class="auth-page" data-component="oauth-consent-page">
      <section class="auth-card">
        <p class="auth-kicker">Authorization request</p>
        <h1 class="auth-title" data-testid="consent-client">Allow {client()?.name ?? clientId() ?? "this application"}?</h1>
        <p class="auth-subtitle">It is requesting access to your Claxedo workspaces on this deployment.</p>
        <Show when={offered().length > 0}>
          <fieldset class="auth-panel">
            <legend class="auth-kicker">Choose what it may do</legend>
            <For each={offered()}>
              {(entry) => (
                <label class="auth-check">
                  <input type="checkbox" checked={granted().has(entry.scope)} onChange={(event) => toggle(entry.scope, event.currentTarget.checked)} />
                  <span>{entry.label}</span>
                </label>
              )}
            </For>
          </fieldset>
        </Show>
        <Show when={carried().length > 0}>
          <div class="auth-panel">
            <p class="auth-kicker">Requested permissions</p>
            <ul class="auth-list"><For each={carried()}>{(scope) => <li>{scope}</li>}</For></ul>
          </div>
        </Show>
        <Show when={failure()}>{(message) => <p role="alert" class="auth-error">{message()}</p>}</Show>
        <div class="auth-buttons">
          <button type="button" class="auth-button auth-button-secondary" disabled={submitting() !== undefined} onClick={() => void decide(false)}>
            {submitting() === "deny" ? "Cancelling…" : "Cancel"}
          </button>
          <button type="button" class="auth-button" disabled={submitting() !== undefined} onClick={() => void decide(true)}>
            {submitting() === "allow" ? "Allowing…" : "Allow"}
          </button>
        </div>
      </section>
    </main>
  )
}

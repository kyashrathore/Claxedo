import { useLocation } from "@solidjs/router"
import { createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import {
  carriedScopes,
  consentDefaults,
  consentRequester,
  offeredMcpScopes,
  readOAuthConsentClient,
  requestedScopes,
  submitOAuthConsent,
  type ConsentRequester,
} from "../oauth-consent"
import "./auth.css"

function ConsentRequesterHeading(props: { requester: ConsentRequester }) {
  return (
    <Switch>
      <Match when={props.requester.kind === "deployment" && props.requester}>
        {(requester) => <h1 class="auth-title" data-testid="consent-client">Allow {requester().name}?</h1>}
      </Match>
      <Match when={props.requester.kind === "unverified" && props.requester}>
        {(requester) => (
          <>
            <h1 class="auth-title" data-testid="consent-client">Allow an unverified application?</h1>
            <p class="auth-subtitle" data-testid="consent-unverified">
              This application registered itself{requester().declaredName ? <> and calls itself “{requester().declaredName}”</> : null}. Claxedo has not checked who runs it.
            </p>
            <Show when={requester().redirectHost}>
              {(host) => <p class="auth-subtitle">Allowing sends your access to <strong data-testid="consent-redirect-host">{host()}</strong>.</p>}
            </Show>
          </>
        )}
      </Match>
    </Switch>
  )
}

export function OAuthConsentPage() {
  const location = useLocation()
  const [submitting, setSubmitting] = createSignal<"allow" | "deny">()
  const [failure, setFailure] = createSignal<string>()
  const query = () => location.search
  const scopes = () => requestedScopes(query())
  const clientId = () => new URLSearchParams(query()).get("client_id")?.trim() || undefined
  const [client] = createResource(clientId, readOAuthConsentClient)
  const requester = () => consentRequester(query(), clientId(), client.state === "ready" ? client()?.name : undefined)
  const offered = () => offeredMcpScopes(scopes(), clientId())
  const carried = () => carriedScopes(scopes())
  const [granted, setGranted] = createSignal<ReadonlySet<string>>(new Set(consentDefaults(requester())))
  const grant = () => [...carried(), ...offered().map((entry) => entry.scope).filter((scope) => granted().has(scope))]

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
    try {
      const destination = await submitOAuthConsent({
        accept,
        oauthQuery: query(),
        ...(accept && scopes().length > 0 ? { scope: grant().join(" ") } : {}),
      })
      window.location.assign(destination)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Consent failed")
      setSubmitting()
    }
  }

  return (
    <main class="auth-page">
      <section class="auth-card">
        <p class="auth-kicker">Authorization request</p>
        <ConsentRequesterHeading requester={requester()} />
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
          <button type="button" class="auth-button" disabled={submitting() !== undefined || (scopes().length > 0 && grant().length === 0)} onClick={() => void decide(true)}>
            {submitting() === "allow" ? "Allowing…" : "Allow"}
          </button>
        </div>
      </section>
    </main>
  )
}

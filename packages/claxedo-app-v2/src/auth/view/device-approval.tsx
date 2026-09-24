import { createResource, createSignal, For, Show } from "solid-js"
import { DEVICE_CODE_MISSING, readDeviceAuthorization, submitDeviceDecision, type DeviceAuthorizationRequest } from "../device-authorization"
import { useAuth } from "../provider"
import "./auth.css"

type Decision = "approved" | "denied"

export function DeviceApprovalPage() {
  const auth = useAuth()
  const [decided, setDecided] = createSignal<Decision>()
  const [submitting, setSubmitting] = createSignal<"approve" | "deny">()
  const [decisionFailure, setDecisionFailure] = createSignal<string>()
  const userCode = () => new URLSearchParams(window.location.search).get("user_code")?.trim()

  const [grant] = createResource(
    () => {
      const code = userCode()
      const state = auth.state().kind
      if (!code || state === "signingIn") return undefined
      return { code, signed: state === "signedIn" }
    },
    async (input): Promise<DeviceAuthorizationRequest | undefined> => {
      if (!input.signed) {
        await auth.signIn({ redirectUrl: window.location.href })
        return undefined
      }
      return readDeviceAuthorization(input.code)
    },
  )

  const ready = () => grant.state === "ready" && grant() !== undefined

  const failureMessage = () => {
    const message = decisionFailure()
    if (message) return message
    if (!userCode()) return DEVICE_CODE_MISSING
    const error: unknown = grant.error
    if (error === undefined) return undefined
    return error instanceof Error ? error.message : "Device authorization failed"
  }

  const decide = async (approve: boolean) => {
    const loaded = grant()
    if (!loaded) return
    setSubmitting(approve ? "approve" : "deny")
    setDecisionFailure()
    try {
      await submitDeviceDecision({ request: loaded, approve })
      setDecided(approve ? "approved" : "denied")
    } catch (error) {
      setDecisionFailure(error instanceof Error ? error.message : "Device authorization failed")
    } finally {
      setSubmitting()
    }
  }

  return (
    <main class="auth-page" data-component="device-approval-page">
      <section class="auth-card">
        <p class="auth-kicker">Device sign-in</p>
        <Show
          when={decided()}
          fallback={
            <>
              <h1 class="auth-title">Connect this device?</h1>
              <p class="auth-subtitle">
                Approve only if you started this sign-in yourself, and only when the code below matches the one the device is showing.
              </p>
              <p class="auth-code" data-testid="device-user-code">{userCode() ?? "--------"}</p>
              <Show when={grant()}>
                {(request) => (
                  <div class="auth-panel">
                    <p>{request().clientId ?? "An unnamed application"}</p>
                    <Show when={request().scopes.length > 0}>
                      <p class="auth-kicker">Requested permissions</p>
                      <ul class="auth-list"><For each={request().scopes}>{(scope) => <li>{scope}</li>}</For></ul>
                    </Show>
                  </div>
                )}
              </Show>
              <Show when={failureMessage()}>{(message) => <p role="alert" class="auth-error">{message()}</p>}</Show>
              <div class="auth-buttons">
                <button type="button" class="auth-button auth-button-secondary" disabled={submitting() !== undefined || !ready()} onClick={() => void decide(false)}>
                  {submitting() === "deny" ? "Denying…" : "Deny"}
                </button>
                <button type="button" class="auth-button" disabled={submitting() !== undefined || !ready()} onClick={() => void decide(true)}>
                  {submitting() === "approve" ? "Approving…" : "Approve"}
                </button>
              </div>
            </>
          }
        >
          {(outcome) => (
            <>
              <h1 class="auth-title">{outcome() === "approved" ? "Device connected" : "Device denied"}</h1>
              <p class="auth-subtitle">You can close this page and return to your terminal.</p>
            </>
          )}
        </Show>
      </section>
    </main>
  )
}

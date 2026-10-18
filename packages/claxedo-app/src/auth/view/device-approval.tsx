import { useLocation, useNavigate } from "@solidjs/router"
import { createResource, createSignal, For, Show } from "solid-js"
import { failureMessage } from "@/lib/failure"
import { deploymentClientName } from "../oauth-consent"
import { readDeviceAuthorization, submitDeviceDecision, type DeviceAuthorizationRequest } from "../device-authorization"
import { appUrl } from "../origins"
import { useAuth } from "../provider"
import "./auth.css"

type DeviceDecision = "approve" | "deny"

export function DeviceApprovalPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const auth = useAuth()
  const [enteredCode, setEnteredCode] = createSignal<string | undefined>(undefined, { equals: false })
  const [denied, setDenied] = createSignal(false)
  const [submitting, setSubmitting] = createSignal<DeviceDecision>()
  const [decisionFailure, setDecisionFailure] = createSignal<string>()

  const [grant] = createResource(
    () => {
      const state = auth.state().kind
      if (state === "signingIn") return undefined
      return { code: enteredCode(), signed: state === "signedIn" }
    },
    async (input): Promise<DeviceAuthorizationRequest | undefined> => {
      if (!input.signed) {
        await auth.signIn({ redirectUrl: appUrl(location) })
        return undefined
      }
      if (!input.code) return undefined
      const request = await readDeviceAuthorization(input.code)
      if (request.status === "approved") navigate("/", { replace: true })
      return request
    },
  )

  const loaded = () => (grant.state === "ready" ? grant() : undefined)
  const pending = () => (loaded()?.status === "pending" ? loaded() : undefined)
  const shownFailure = () => decisionFailure() ?? (grant.error === undefined ? undefined : failureMessage(grant.error))

  const enterCode = (code: string) => {
    setDecisionFailure()
    setEnteredCode(code)
  }

  const decide = async (request: DeviceAuthorizationRequest, decision: DeviceDecision) => {
    setSubmitting(decision)
    setDecisionFailure()
    try {
      await submitDeviceDecision({ request, approve: decision === "approve" })
      if (decision === "approve") navigate("/", { replace: true })
      else setDenied(true)
    } catch (error) {
      setDecisionFailure(failureMessage(error))
    } finally {
      setSubmitting()
    }
  }

  return (
    <main class="auth-page">
      <section class="auth-card">
        <p class="auth-kicker">Device sign-in</p>
        <Show when={!denied() && loaded()?.status !== "denied"} fallback={<DeviceDenied />}>
          <h1 class="auth-title">Connect this device?</h1>
          <Show when={pending()} fallback={<DeviceCodeForm checking={grant.loading} onSubmit={enterCode} />}>
            {(request) => (
              <DeviceRequestReview request={request()} submitting={submitting()} onDecide={(decision) => void decide(request(), decision)} />
            )}
          </Show>
          <Show when={shownFailure()}>{(message) => <p role="alert" class="auth-error">{message()}</p>}</Show>
        </Show>
      </section>
    </main>
  )
}

function DeviceCodeForm(props: { checking: boolean; onSubmit: (code: string) => void }) {
  const [code, setCode] = createSignal("")
  return (
    <form
      class="auth-form"
      onSubmit={(event) => {
        event.preventDefault()
        const typed = code().trim()
        if (typed) props.onSubmit(typed)
      }}
    >
      <p class="auth-subtitle">Type the code your terminal is showing. Continue only if you started this sign-in yourself.</p>
      <label class="auth-field">
        Device code
        <input
          type="text"
          required
          autocomplete="off"
          autocapitalize="characters"
          spellcheck={false}
          value={code()}
          onInput={(event) => setCode(event.currentTarget.value)}
        />
      </label>
      <button type="submit" class="auth-button" disabled={props.checking}>
        {props.checking ? "Checking…" : "Continue"}
      </button>
    </form>
  )
}

function DeviceRequestReview(props: {
  request: DeviceAuthorizationRequest
  submitting: DeviceDecision | undefined
  onDecide: (decision: DeviceDecision) => void
}) {
  return (
    <>
      <p class="auth-subtitle" data-testid="device-warning">
        Approving gives that device full access to your Claxedo account. Approve only if you just started this sign-in yourself on a computer you control; if someone sent you this link, deny it.
      </p>
      <p class="auth-code" data-testid="device-user-code">{props.request.userCode}</p>
      <div class="auth-panel">
        <p data-testid="device-client">{deploymentClientName(props.request.clientId) ?? props.request.clientId ?? "An unnamed application"}</p>
        <Show when={props.request.scopes.length > 0}>
          <p class="auth-kicker">Requested permissions</p>
          <ul class="auth-list"><For each={props.request.scopes}>{(scope) => <li>{scope}</li>}</For></ul>
        </Show>
      </div>
      <div class="auth-buttons">
        <button type="button" class="auth-button auth-button-secondary" disabled={props.submitting !== undefined} onClick={() => props.onDecide("deny")}>
          {props.submitting === "deny" ? "Denying…" : "Deny"}
        </button>
        <button type="button" class="auth-button" disabled={props.submitting !== undefined} onClick={() => props.onDecide("approve")}>
          {props.submitting === "approve" ? "Approving…" : "Approve"}
        </button>
      </div>
    </>
  )
}

function DeviceDenied() {
  return (
    <>
      <h1 class="auth-title">Device denied</h1>
      <p class="auth-subtitle">You can close this page and return to your terminal.</p>
    </>
  )
}

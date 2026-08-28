import { createSignal, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"

import { useAccountPort } from "@/platform/account/account-provider"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"

type BootstrapOwnerResponse = {
  user?: { id?: unknown }
  organizations?: unknown
  error?: { code?: unknown; message?: unknown }
}

function message(value: BootstrapOwnerResponse, status: number) {
  if (typeof value.error?.message === "string" && value.error.message) return value.error.message
  if (typeof value.error?.code === "string" && value.error.code) return value.error.code
  return `Owner activation failed (${status})`
}

/**
 * Explicit one-time bootstrap for the user-deployed product.
 *
 * The claim is held only in this component signal and sent once to the
 * application-owned activation route. It is never put in a URL, storage, or
 * provider callback. The server binds it to the already verified auth subject
 * and consumes claim + owner/org transactionally.
 */
export default function BootstrapOwnerPage() {
  const account = useAccountPort()
  const navigate = useNavigate()
  const [claim, setClaim] = createSignal("")
  const [journeyId, setJourneyId] = createSignal("")
  const [operationId, setOperationId] = createSignal("")
  const [submitting, setSubmitting] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()

  const signed = () => account.state().status === "signed"
  const userId = () => {
    const state = account.state()
    return state.status === "signed" ? state.identity.userId : ""
  }

  const signIn = async () => {
    setFailure()
    try {
      await account.signIn({ redirectUrl: window.location.href })
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Sign-in failed")
    }
  }

  const activate = async () => {
    setSubmitting(true)
    setFailure()
    try {
      const headers = new Headers({
        "x-claxedo-bootstrap-owner-claim": claim(),
      })
      if (journeyId()) headers.set("x-claxedo-canary-journey-id", journeyId())
      if (operationId()) headers.set("x-claxedo-canary-mutation-operation-id", operationId())
      const response = await authFetch(
        new URL("/api/claxedo/auth/bootstrap-owner", getClaxedoServerUrl()),
        { method: "POST", headers },
      )
      const body = (await response.json().catch(() => ({}))) as BootstrapOwnerResponse
      if (!response.ok) throw new Error(message(body, response.status))
      if (typeof body.user?.id !== "string" || !Array.isArray(body.organizations) || body.organizations.length !== 1) {
        throw new Error("Owner activation returned an invalid application profile")
      }
      setClaim("")
      navigate("/", { replace: true })
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Owner activation failed")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main class="flex min-h-screen items-center justify-center bg-background-base p-4 text-text-strong">
      <section class="w-full max-w-md space-y-5 rounded-xl border border-border-weak-base bg-surface-base p-6">
        <div>
          <h1 class="text-xl font-semibold">Activate deployment owner</h1>
          <p class="mt-2 text-sm text-text-weak">
            This one-time step creates the deployment organization and makes the verified account its owner.
          </p>
        </div>

        <Show
          when={signed()}
          fallback={(
            <button
              type="button"
              class="w-full rounded-lg bg-surface-interactive-base px-4 py-3 text-sm font-medium text-text-on-interactive-base"
              onClick={() => void signIn()}
            >
              Sign in to continue
            </button>
          )}
        >
          <p class="rounded-lg bg-surface-raised-base p-3 text-sm">
            Verified account ID: <code class="select-all">{userId()}</code>
          </p>
          <form
            class="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              void activate()
            }}
          >
            <label class="block text-sm text-text-weak">
              One-time owner claim
              <input
                type="password"
                required
                autocomplete="off"
                value={claim()}
                onInput={(event) => setClaim(event.currentTarget.value)}
                class="mt-1 w-full rounded-lg border border-border-weak-base bg-background-base px-3 py-2 text-text-strong"
              />
            </label>
            <label class="block text-sm text-text-weak">
              Canary journey ID
              <input
                type="password"
                autocomplete="off"
                value={journeyId()}
                onInput={(event) => setJourneyId(event.currentTarget.value)}
                class="mt-1 w-full rounded-lg border border-border-weak-base bg-background-base px-3 py-2 text-text-strong"
              />
            </label>
            <label class="block text-sm text-text-weak">
              Canary mutation operation ID
              <input
                type="password"
                autocomplete="off"
                value={operationId()}
                onInput={(event) => setOperationId(event.currentTarget.value)}
                class="mt-1 w-full rounded-lg border border-border-weak-base bg-background-base px-3 py-2 text-text-strong"
              />
            </label>
            <button
              type="submit"
              disabled={submitting() || !claim()}
              class="w-full rounded-lg bg-surface-interactive-base px-4 py-3 text-sm font-medium text-text-on-interactive-base disabled:cursor-wait disabled:opacity-70"
            >
              {submitting() ? "Activating..." : "Activate owner"}
            </button>
          </form>
        </Show>

        <Show when={failure()}>
          {(value) => <p role="alert" class="text-sm text-icon-critical-base">{value()}</p>}
        </Show>
      </section>
    </main>
  )
}

import { createResource, createSignal, For, Show, Suspense } from "solid-js"
import { readString } from "@/lib/record"
import { useAuthSession } from "@/platform/auth/auth-session"
import { betterAuthApiError } from "@/platform/auth/better-auth-api-error"

export type DeviceAuthorizationRequest = {
  userCode: string
  status: "pending" | "approved" | "denied"
  clientId?: string
  scopes: readonly string[]
  /** Present only for the user this request is claimed for; a decision without it is refused. */
  transaction?: string
}

export const DEVICE_CODE_MISSING = "This link is missing its device code. Re-run the command and open the URL it prints."

function grantStatus(value: unknown): DeviceAuthorizationRequest["status"] {
  const status = readString(value, "status")
  if (status === "approved" || status === "denied") return status
  return "pending"
}

export async function readDeviceAuthorization(
  userCode: string,
  request: typeof fetch,
  apiOrigin: string,
): Promise<DeviceAuthorizationRequest> {
  const url = new URL("/api/auth/device", apiOrigin)
  url.searchParams.set("user_code", userCode)
  const response = await request(url.toString(), { credentials: "include", headers: { accept: "application/json" } })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) throw betterAuthApiError(body, response.status, "Device authorization failed")
  const clientId = readString(body, "client_id")
  const transaction = readString(body, "transaction")
  return {
    userCode,
    status: grantStatus(body),
    ...(clientId ? { clientId } : {}),
    ...(transaction ? { transaction } : {}),
    scopes: (readString(body, "scope") ?? "").split(/\s+/).filter(Boolean),
  }
}

export async function submitDeviceDecision(
  input: { request: DeviceAuthorizationRequest; approve: boolean },
  request: typeof fetch,
  apiOrigin: string,
): Promise<void> {
  const response = await request(
    new URL(`/api/auth/device/${input.approve ? "approve" : "deny"}`, apiOrigin).toString(),
    {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userCode: input.request.userCode, transaction: input.request.transaction }),
    },
  )
  if (!response.ok) {
    throw betterAuthApiError(await response.json().catch(() => undefined), response.status, "Device authorization failed")
  }
}

/**
 * The page `oauthDeviceAuthorization`'s `verificationUri` points at.
 *
 * Better Auth serves the device grant's JSON endpoints and no HTML, so
 * `claxedo login` printed a URL nothing answered: the user code was minted,
 * the CLI polled, and there was no way to approve it.
 */
export default function DeviceApprovalPage(props: {
  request: typeof fetch
  apiOrigin: string
  load?: (userCode: string) => Promise<DeviceAuthorizationRequest>
  submit?: (input: { request: DeviceAuthorizationRequest; approve: boolean }) => Promise<void>
}) {
  const auth = useAuthSession()
  const [decided, setDecided] = createSignal<"approved" | "denied">()
  const [submitting, setSubmitting] = createSignal<"approve" | "deny">()
  const [decisionFailure, setDecisionFailure] = createSignal<string>()

  const userCode = () => new URLSearchParams(window.location.search).get("user_code")?.trim()
  const load = props.load ?? ((code: string) => readDeviceAuthorization(code, props.request, props.apiOrigin))
  const submit = props.submit ?? ((input: { request: DeviceAuthorizationRequest; approve: boolean }) =>
    submitDeviceDecision(input, props.request, props.apiOrigin))

  const [grant] = createResource(
    () => {
      const code = userCode()
      if (!code || auth.status() === "loading") return undefined
      return { code, signed: auth.status() === "signed" }
    },
    async (input) => {
      // The user arrives here from a terminal, so this browser may never have
      // seen Claxedo. Sign-in navigates away and comes back to this same link.
      if (!input.signed) {
        await auth.signIn({ redirectUrl: window.location.href })
        return undefined
      }
      return load(input.code)
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
      await submit({ request: loaded, approve })
      setDecided(approve ? "approved" : "denied")
    } catch (err) {
      setDecisionFailure(err instanceof Error ? err.message : "Device authorization failed")
    } finally {
      setSubmitting()
    }
  }

  return (
    <main class="flex min-h-screen items-center justify-center bg-background-base p-4 text-text-strong">
      <section class="w-full max-w-md rounded-xl border border-border-weak-base bg-surface-base p-6 shadow-lg">
        <p class="mb-2 text-xs font-medium uppercase tracking-wide text-text-weaker">Device sign-in</p>

        <Show
          when={decided()}
          fallback={
            <>
              <h1 class="mb-2 text-2xl font-semibold">Connect this device?</h1>
              <p class="mb-5 text-sm text-text-weak">
                Approve only if you started this sign-in yourself, and only when the code below matches the one
                the device is showing.
              </p>
              <p class="mb-5 font-mono text-2xl tracking-widest text-text-strong" data-testid="device-user-code">
                {userCode() ?? "--------"}
              </p>

              <Suspense>
                <Show when={grant()}>
                  {(request) => (
                    <div class="mb-6 rounded-lg border border-border-weak-base bg-background-base p-4">
                      <p class="text-sm text-text-strong">{request().clientId ?? "An unnamed application"}</p>
                      <Show when={request().scopes.length > 0}>
                        <p class="mt-3 mb-2 text-xs font-medium text-text-weaker">Requested permissions</p>
                        <ul class="space-y-1 text-sm text-text-weak">
                          <For each={request().scopes}>{(scope) => <li>{scope}</li>}</For>
                        </ul>
                      </Show>
                    </div>
                  )}
                </Show>
              </Suspense>

              <Show when={failureMessage()}>
                {(message) => <p role="alert" class="mb-4 text-sm text-icon-critical-base">{message()}</p>}
              </Show>

              <div class="flex justify-end gap-3">
                <button
                  type="button"
                  class="rounded-lg border border-border-weak-base px-4 py-2 text-sm font-medium text-text-weak disabled:cursor-wait disabled:opacity-60"
                  disabled={submitting() !== undefined || !ready()}
                  onClick={() => void decide(false)}
                >
                  {submitting() === "deny" ? "Denying..." : "Deny"}
                </button>
                <button
                  type="button"
                  class="rounded-lg bg-surface-interactive-base px-4 py-2 text-sm font-medium text-text-on-interactive-base disabled:cursor-wait disabled:opacity-60"
                  disabled={submitting() !== undefined || !ready()}
                  onClick={() => void decide(true)}
                >
                  {submitting() === "approve" ? "Approving..." : "Approve"}
                </button>
              </div>
            </>
          }
        >
          {(outcome) => (
            <>
              <h1 class="mb-2 text-2xl font-semibold">
                {outcome() === "approved" ? "Device connected" : "Device denied"}
              </h1>
              <p class="text-sm text-text-weak">You can close this page and return to your terminal.</p>
            </>
          )}
        </Show>
      </section>
    </main>
  )
}

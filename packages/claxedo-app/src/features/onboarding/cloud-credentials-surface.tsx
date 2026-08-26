import { For, Show, createMemo, createSignal, onSettled, type Component } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { shareCredentialsWithCloud, type CloudShareOutcome } from "./cloud-credentials-api"
import { cloudShareBlock, isCloudShareable } from "./credential-sharing"
import type { SetupStepSubmit } from "./ai-connect-surface"
import type { AIConnectRequest } from "./ai-connect-api"
import type { OnboardingCredential } from "./state"

export type CloudCredentialsSurfaceProps = {
  /** Usable credentials this machine holds that the cloud cannot reach yet. */
  candidates: readonly OnboardingCredential[]
  /**
   * Machine-local credentials the cloud cannot keep working. Listed, never
   * offered: a user who sees Claude working locally and no Claude row here
   * would reasonably conclude we lost it.
   */
  blocked?: readonly OnboardingCredential[]
  /** Credentials already shared — shown as settled, never as work to redo. */
  shared: readonly OnboardingCredential[]
  providerLabel?: string
  serverUrl?: string
  request?: AIConnectRequest
  onShared?: () => void | Promise<void>
  /**
   * Reports the share action to the page — its count and busy state, and a way
   * to run it. The footer no longer commits, so this is what the shell reads to
   * know whether the step has work outstanding; the body owns the button.
   */
  registerSubmit?: (submit: SetupStepSubmit) => void
}

export const CloudCredentialsSurface: Component<CloudCredentialsSurfaceProps> = (props) => {
  const [selected, setSelected] = createSignal<Record<string, boolean>>({})
  const [outcomes, setOutcomes] = createSignal<Record<string, CloudShareOutcome>>({})
  const [busy, setBusy] = createSignal(false)

  const isSelected = (id: string) => selected()[id] ?? true
  // Offerable is decided here as well as by the caller. A share is irreversible
  // from the user's side — the token is in a sandbox — so the rule holds at the
  // surface that renders the checkbox, not only at the state that fills it.
  const offerable = createMemo(() => props.candidates.filter(isCloudShareable))
  const chosen = createMemo(() => offerable().filter((credential) => isSelected(credential.id)))
  // A non-shareable row reaching `candidates` is a caller bug, but the user
  // still gets the explanation rather than a silently missing credential. Only
  // rows that HAVE an explanation are listed — a sandbox driver token was never
  // part of this question and explaining its absence would only confuse.
  const blockedRows = createMemo(() =>
    [...props.candidates, ...(props.blocked ?? [])].filter((credential) => cloudShareBlock(credential)),
  )

  async function share() {
    const ids = chosen().map((credential) => credential.id)
    if (ids.length === 0) return
    setBusy(true)
    const results = await shareCredentialsWithCloud({
      serverUrl: props.serverUrl,
      credentialIds: ids,
      request: props.request,
    })
    setOutcomes((current) => ({
      ...current,
      ...Object.fromEntries(results.map((result) => [result.credentialId, result])),
    }))
    setBusy(false)
    // Any success is progress worth committing, even if a sibling failed.
    if (results.some((result) => result.ok)) await props.onShared?.()
  }

  onSettled(() => {
    props.registerSubmit?.({ run: share, count: () => chosen().length, busy })
  })

  return (
    <div class="setup-block" data-component="cloud-credentials-surface">
      <Show when={props.shared.length > 0}>
        <div class="setup-rows">
          <For each={props.shared}>
            {(credential) => (
              <div class="setup-row">
                <span class="setup-row-copy">
                  <span class="text-13-medium text-text-strong">{credentialName(credential)}</span>
                  <span class="setup-row-consequence text-12-regular">Cloud sandboxes can already use this.</span>
                </span>
                <span class="setup-verified text-12-regular">
                  <Icon name="circle-check" size="small" />
                  Shared
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show
        when={offerable().length > 0}
        fallback={
          <Show when={props.shared.length === 0 && blockedRows().length === 0}>
            <p class="text-13-regular text-text-weak">No credentials on this machine are available to share yet.</p>
          </Show>
        }
      >
        <div class="setup-block">
          <div class="setup-rows">
            <For each={offerable()}>
              {(credential) => {
                const outcome = () => outcomes()[credential.id]
                return (
                  <div class="setup-row">
                    <Checkbox
                      class="setup-row-copy"
                      checked={isSelected(credential.id)}
                      disabled={busy() || outcome()?.ok === true}
                      description={
                        credential.verification === "rate_capped"
                          ? "At its usage limit right now — it will work again when the limit resets."
                          : "Stored on this machine only."
                      }
                      onChange={(checked: boolean) =>
                        setSelected((current) => ({ ...current, [credential.id]: checked }))
                      }
                    >
                      {credentialName(credential)}
                    </Checkbox>
                    {/* Per-credential outcome: one failure never hides the rest. */}
                    <Show when={outcome()?.ok === true}>
                      <span class="setup-verified text-12-regular">
                        <Icon name="circle-check" size="small" />
                        Shared
                      </span>
                    </Show>
                    <Show when={failureReason(outcome())}>
                      {(reason) => (
                        <span class="setup-status text-12-regular">
                          <Icon name="warning" size="small" />
                          {reason()}
                        </span>
                      )}
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>

          <p class="text-12-regular text-text-weak">
            {props.providerLabel
              ? `Agents running on ${props.providerLabel} will be able to spend these credentials. `
              : "Agents running in the cloud will be able to spend these credentials. "}
            Using a subscription credential there is your choice and may be subject to your provider's terms.
          </p>

          {/* The action sits with the rows it acts on, under the sentence that
              says what sharing costs. The footer is for moving between steps,
              so a button that WIDENS who can spend a credential cannot live
              there. */}
          <Show when={chosen().length > 0}>
            <Button class="self-start" disabled={busy()} onClick={() => void share()}>
              {busy() ? "Sharing…" : `Share ${chosen().length} credential${chosen().length === 1 ? "" : "s"}`}
            </Button>
          </Show>

          <Show when={busy()}>
            <div class="flex items-center gap-2 text-13-regular text-text-base">
              <Spinner />
              Sharing with your cloud sandboxes…
            </div>
          </Show>
        </div>
      </Show>

      <Show when={blockedRows().length > 0}>
        <div class="setup-rows">
          <For each={blockedRows()}>
            {(credential) => {
              const block = cloudShareBlock(credential)
              return (
                <div class="setup-row">
                  <span class="setup-row-copy">
                    <span class="text-13-medium text-text-strong">{credentialName(credential)}</span>
                    <span class="setup-row-consequence text-12-regular">
                      {block?.reason}
                      <Show when={block?.repair}> {block?.repair}</Show>
                    </span>
                  </span>
                  <span class="setup-status text-12-regular">Stays on this machine</span>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}

function failureReason(outcome: CloudShareOutcome | undefined) {
  return outcome && !outcome.ok ? outcome.reason : undefined
}

function credentialName(credential: OnboardingCredential) {
  const base = credential.label ?? credential.providerId
  return credential.accountId ? `${base} · ${credential.accountId}` : base
}

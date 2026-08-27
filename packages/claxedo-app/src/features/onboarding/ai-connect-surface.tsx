import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { TextField } from "@opencode-ai/ui/text-field"
import { For, Show, createMemo, createSignal, onMount, type Component } from "solid-js"
import { ProviderConnectForm, ProviderList } from "./app-ports"
import { queryClient } from "@/platform/query/query-client"
import {
  discoverAIConnections,
  saveDiscoveredAIConnections,
  type AIConnectRequest,
  type AIVerificationResult,
} from "./ai-connect-api"
import {
  aiConnectFailureCopy,
  aiConnectTransition,
  connectionDisplayName,
  destinationStoresCredentials,
  groupConnectResults,
  initialAIConnectState,
  isUsableResult,
  localHarnessStatuses,
  type LocalHarnessStatus,
  type AIConnectEvent,
  type AIDiscoveryProbe,
  type AIDiscoveryRow,
  type AIConnectState,
  type OnboardingDestination,
} from "./ai-connect-state"
import type { OnboardingFunnelEvent } from "./funnel"

/** How a Claude subscription or account reaches a cloud sandbox. */
export type ClaudeCloudMethod = "api-key" | "setup-token"

/**
 * Which sub-screen of the AI step is showing. The step branches, so it is a
 * location — not a pile of sections stacked on one scrolling screen.
 */
export type AIConnectView =
  | { kind: "chooser" }
  | { kind: "detect" }
  | { kind: "providers" }
  | { kind: "connect"; providerId: string }
  | { kind: "claude"; method?: ClaudeCloudMethod }

/**
 * What each harness needs in the cloud, which is not the same answer three
 * times: Codex carries its ChatGPT login, Claude needs one of its own, Cursor
 * takes a dashboard key.
 *
 * `providerId` is the AUTH id, which is what decides the sign-in methods on
 * offer — `codex-acp` is the one that carries the ChatGPT OAuth flow, and
 * `cursor-acp` the dashboard key. These are deliberately not model-catalog ids.
 */
const cloudHarnessOptions: readonly {
  id: string
  label: string
  consequence: string
  view: AIConnectView
}[] = [
  {
    id: "codex",
    label: "Codex",
    consequence: "Sign in with ChatGPT. Cloud agents then use your Plus or Pro plan.",
    view: { kind: "connect", providerId: "codex-acp" },
  },
  {
    id: "claude",
    label: "Claude",
    consequence: "Paste an API key, or create a token from your subscription with one command.",
    view: { kind: "claude" },
  },
  {
    id: "cursor",
    label: "Cursor",
    consequence: "Paste a key from the Cursor dashboard.",
    view: { kind: "connect", providerId: "cursor-acp" },
  },
]

export type AIConnectSurfaceProps = {
  localDiscovery: boolean
  serverUrl?: string
  defaultScope?: "local" | "shared"
  request?: AIConnectRequest
  deviceLoginConfigured?: boolean
  /**
   * Where this user's agents will run. Drives whether the step COLLECTS a
   * credential or merely CONFIRMS the machine already has a usable login:
   * a local harness spawns the user's own binary and inherits its auth, so a
   * stored copy is a second copy of something that already worked — and one
   * Claude Code will rotate out from under us within hours.
   *
   * Unset means `both`, which collects exactly as this step always has.
   */
  destination?: OnboardingDestination
  /**
   * Start the scan on mount rather than waiting for a click. For callers that
   * open this surface directly on its check, where there is no button to press.
   */
  autoDiscover?: boolean
  /** Controlled by the page so Back in the action bar can unwind the sub-flow. */
  view: AIConnectView
  onViewChange: (view: AIConnectView) => void
  invalidateQueries?: () => Promise<void>
  onConnected?: (results: AIVerificationResult[]) => void | Promise<void>
  /** Reports harnesses whose local login probe proved they can run. */
  onLocalHarnessesDetected?: (harnesses: readonly string[]) => void
  emit?: (event: Extract<OnboardingFunnelEvent, { name: "provider_connected" | "step_verify_failed" }>) => void
  /**
   * Lets the page's action bar drive the save. The detect screen's primary
   * action carries the count of what will actually be written, so it cannot live
   * inside the scrolling body.
   */
  registerSubmit?: (submit: SetupStepSubmit) => void
}

export type SetupStepSubmit = {
  run: () => Promise<void>
  /** How many items the primary action would act on; 0 hides it. */
  count: () => number
  busy: () => boolean
}

export const AIConnectSurface: Component<AIConnectSurfaceProps> = (props) => {
  const [state, setState] = createSignal(initialAIConnectState())
  const scope = () => props.defaultScope ?? (props.localDiscovery ? "local" : "shared")
  const destination = () => props.destination ?? "both"
  const stores = () => destinationStoresCredentials(destination())
  const busy = createMemo(() => state().phase === "discovering" || state().phase === "saving")
  const preview = createMemo<Extract<AIConnectState, { phase: "preview" }> | undefined>(() => {
    const current = state()
    return current.phase === "preview" ? current : undefined
  })
  const confirmed = createMemo<Extract<AIConnectState, { phase: "confirmed" }> | undefined>(() => {
    const current = state()
    return current.phase === "confirmed" ? current : undefined
  })
  const settled = createMemo<Extract<AIConnectState, { phase: "settled" }> | undefined>(() => {
    const current = state()
    return current.phase === "settled" ? current : undefined
  })
  const error = createMemo<Extract<AIConnectState, { phase: "error" }> | undefined>(() => {
    const current = state()
    return current.phase === "error" ? current : undefined
  })

  const transition = (event: AIConnectEvent) => setState((current) => aiConnectTransition(current, event))
  const invalidate = () => props.invalidateQueries?.() ?? invalidateAIConnectQueries()
  const selectedCount = createMemo(() => {
    const current = state()
    if (current.phase !== "preview") return 0
    return current.items.filter((item) => item.selected && !item.alreadyConnected).length
  })

  props.registerSubmit?.({ run: saveDiscovered, count: selectedCount, busy })

  // An entry point that opens straight onto the check — the go-further card —
  // has no click to start the scan, so it asks for one here. Inferring this
  // from `view === "detect"` instead would also fire on the ordinary
  // click-through path, scanning twice.
  if (props.autoDiscover) {
    // `onMount` runs once outside any tracking scope, so reading the phase here
    // creates no subscription — this is a guard against a caller that mounts
    // with work already in flight, not a reactive dependency.
    onMount(() => {
      if (state().phase === "idle") void discover()
    })
  }

  async function discover() {
    props.onViewChange({ kind: "detect" })
    transition({ type: "discovery-started" })
    await discoverAIConnections({ serverUrl: props.serverUrl, request: props.request })
      .then((result) => {
        transition({
          type: "discovery-succeeded",
          discoveryId: result.discoveryId,
          items: result.items,
          destination: destination(),
        })
        const current = state()
        if (current.phase !== "confirmed") return
        props.onLocalHarnessesDetected?.(
          localHarnessStatuses(current.rows)
            .filter((harness) => harness.state === "working")
            .map((harness) => harness.id),
        )
      })
      .catch((error: unknown) => transition({ type: "failed", message: errorMessage(error) }))
  }

  /**
   * The save path is cloud-only. A local-only run never reaches `preview`, and
   * this second check keeps that true if some future caller drives the state
   * machine directly — writing a credential the local harness never reads is
   * not a cosmetic mistake, it can log the user out of their own Claude Code.
   */
  async function saveDiscovered() {
    const current = state()
    if (current.phase !== "preview" || !stores()) return
    const selected = current.items.filter((item) => item.selected && !item.alreadyConnected)
    if (selected.length === 0) return
    transition({ type: "save-started" })
    await saveDiscoveredAIConnections({
      serverUrl: props.serverUrl,
      discoveryId: current.discoveryId,
      // One row, both bindings: the user made one decision about one login, so
      // each harness binding is written rather than left half-connected.
      items: selected.flatMap((item) => item.providerIds.map((providerId) => ({
        providerId,
        accountId: item.accountId,
        scope: scope(),
      }))),
      request: props.request,
    })
      .then(complete)
      .catch((error: unknown) => transition({ type: "failed", message: errorMessage(error) }))
  }

  /**
   * Every credential reports its own outcome. The previous reduction took the
   * first non-ok result, rendered one banner, and returned early — so a batch
   * where three of four verified looked like a total failure and the step never
   * advanced.
   */
  async function complete(results: AIVerificationResult[]) {
    await invalidate()
    if (results.length === 0) {
      transition({ type: "failed", message: "No saved credential was available to verify." })
      return
    }
    transition({ type: "settled", results })
    results.filter((result) => !isUsableResult(result.result))
      .forEach((result) => props.emit?.({ name: "step_verify_failed", step: "ai", class: result.result }))
    const usable = results.filter((result) => isUsableResult(result.result))
    usable.forEach((result) => props.emit?.({ name: "provider_connected", provider: result.providerId }))
    // Any usable credential is progress: let the step complete rather than
    // holding the user on a screen whose remaining rows they cannot fix now.
    if (usable.length > 0) await props.onConnected?.(results)
  }

  return (
    <div class="setup-block" data-component="ai-connect-surface" data-view={props.view.kind}>
      <Show when={props.view.kind === "chooser"}>
        {/*
          Local and cloud are different questions, not two routes to one answer.
          Locally every harness already has a login, so there is one button and
          nothing to choose. In the cloud a sandbox starts empty, and what it
          needs differs per harness — so the cloud screen is the list of
          harnesses, each with the one thing that actually works for it.
        */}
        <Show
          when={stores()}
          fallback={
            <div class="setup-block">
              <p class="text-13-regular text-text-base">
                Agents here use the Claude Code, Codex, and Cursor logins already on this computer. Nothing to paste.
              </p>
              <Button class="self-start" disabled={busy()} onClick={() => void discover()}>
                Check my logins
              </Button>
            </div>
          }
        >
          <div class="setup-rows">
            <For each={cloudHarnessOptions}>
              {(option) => (
                <button
                  type="button"
                  class="setup-row"
                  onClick={() => props.onViewChange(option.view)}
                >
                  <span class="setup-row-copy">
                    <span class="text-13-medium text-text-strong">{option.label}</span>
                    <span class="setup-row-consequence text-12-regular">{option.consequence}</span>
                  </span>
                  <Icon name="chevron-right" size="small" class="setup-row-chevron" />
                </button>
              )}
            </For>
            <button type="button" class="setup-row" onClick={() => props.onViewChange({ kind: "providers" })}>
              <span class="setup-row-copy">
                <span class="text-13-medium text-text-strong">Something else</span>
                <span class="setup-row-consequence text-12-regular">
                  Copilot, Gemini, or any other provider — sign in or paste a key.
                </span>
              </span>
              <Icon name="chevron-right" size="small" class="setup-row-chevron" />
            </button>
            <Show when={props.localDiscovery}>
              <button type="button" class="setup-row" onClick={() => void discover()}>
                <span class="setup-row-copy">
                  <span class="text-13-medium text-text-strong">Send a login from this computer</span>
                  <span class="setup-row-consequence text-12-regular">
                    Pick from the logins already on this computer.
                  </span>
                </span>
                <Icon name="chevron-right" size="small" class="setup-row-chevron" />
              </button>
            </Show>
            <Show when={!props.localDiscovery && props.deviceLoginConfigured}>
              <div class="setup-row">
                <span class="setup-row-copy">
                  <span class="text-13-medium text-text-strong">Connect from a terminal</span>
                  <span class="setup-row-consequence text-12-regular">
                    Push an existing subscription from the CLI, then return here.
                  </span>
                  <TextField label="Terminal command" value="npx claxedo connect claude" readOnly copyable />
                </span>
              </div>
            </Show>
          </div>
        </Show>
      </Show>

      <Show when={props.view.kind === "providers"}>
        <ProviderList
          hideCustom
          onSelect={(providerId: string) => props.onViewChange({ kind: "connect", providerId })}
        />
      </Show>

      <Show when={props.view.kind === "claude" ? props.view : undefined}>
        {(view) => (
          <Show
            when={view().method}
            fallback={
              <div class="setup-rows">
                <button
                  type="button"
                  class="setup-row"
                  onClick={() => props.onViewChange({ kind: "claude", method: "setup-token" })}
                >
                  <span class="setup-row-copy">
                    <span class="text-13-medium text-text-strong">Use your Claude subscription</span>
                    <span class="setup-row-consequence text-12-regular">
                      Run one command in your terminal and paste what it prints.
                    </span>
                  </span>
                  <Icon name="chevron-right" size="small" class="setup-row-chevron" />
                </button>
                <button
                  type="button"
                  class="setup-row"
                  onClick={() => props.onViewChange({ kind: "claude", method: "api-key" })}
                >
                  <span class="setup-row-copy">
                    <span class="text-13-medium text-text-strong">Use an API key</span>
                    <span class="setup-row-consequence text-12-regular">
                      Create a key at platform.claude.com and paste it. You pay per token.
                    </span>
                  </span>
                  <Icon name="chevron-right" size="small" class="setup-row-chevron" />
                </button>
              </div>
            }
          >
            {(method) => (
              <div class="setup-block">
                <Show when={method() === "setup-token"}>
                  <div class="setup-block">
                    <p class="text-13-regular text-text-base">
                      Run this once in your terminal. Paste the token it prints — cloud agents then use your Claude
                      subscription for about a year.
                    </p>
                    <TextField label="Terminal command" value="claude setup-token" readOnly copyable />
                  </div>
                </Show>
                {/*
                  Both methods land in the same paste field and store as
                  `api_key`. That is not a shortcut: `claudeAuthEnv` reads the
                  secret's SHAPE, so an `sk-ant-oat01-…` value is sent as
                  CLAUDE_CODE_OAUTH_TOKEN and a plain key as ANTHROPIC_API_KEY,
                  with nothing here to keep in step.
                */}
                <ProviderConnectForm
                  provider="anthropic"
                  scope="shared"
                  hideHeading
                  onConnected={async () => {
                    await invalidate()
                    props.emit?.({ name: "provider_connected", provider: "anthropic" })
                  }}
                  onDone={() => void props.onConnected?.([])}
                />
              </div>
            )}
          </Show>
        )}
      </Show>

      <Show when={props.view.kind === "connect" ? props.view : undefined}>
        {(view) => (
          <ProviderConnectForm
            provider={view().providerId}
            scope={scope()}
            hideHeading
            onConnected={async () => {
              await invalidate()
              props.emit?.({ name: "provider_connected", provider: view().providerId })
            }}
            onDone={() => void props.onConnected?.([])}
          />
        )}
      </Show>

      <Show when={props.view.kind === "detect"}>
        <Show when={state().phase === "discovering"}>
          <div class="flex items-center gap-2 text-13-regular text-text-base">
            <Spinner />
            Scanning this machine…
          </div>
        </Show>

        <Show when={preview()}>
          {(current) => (
            <Show
              when={current().items.length > 0}
              fallback={
                <div class="setup-block">
                  <p class="text-13-regular text-text-weak">No supported logins found on this machine.</p>
                  <Button class="self-start" variant="secondary" onClick={() => props.onViewChange({ kind: "providers" })}>
                    Choose a provider instead
                  </Button>
                </div>
              }
            >
              <div class="setup-rows">
                <For each={current().items}>
                  {(item) => (
                    <div class="setup-row">
                      <Checkbox
                        class="setup-row-copy"
                        checked={item.selected}
                        disabled={item.alreadyConnected || busy()}
                        description={rowDescription(item)}
                        onChange={(checked: boolean) =>
                          transition({ type: "selection-changed", selectionId: item.selectionId, selected: checked })}
                      >
                        {item.label}
                      </Checkbox>
                      <Show when={item.alreadyConnected}>
                        <span class="setup-verified text-12-regular">
                          <Icon name="circle-check" size="small" />
                          Already connected
                        </span>
                      </Show>
                      {/* The verdict from the live probe run during the scan —
                          shown before anything is saved, so a credential that
                          cannot work is never presented as ready. */}
                      <Show when={!item.alreadyConnected && item.probe?.state === "working"}>
                        <span class="setup-verified text-12-regular">
                          <Icon name="circle-check" size="small" />
                          Working
                        </span>
                      </Show>
                      <Show when={!item.alreadyConnected && probeReason(item.probe, "broken")}>
                        {(reason) => (
                          <span class="setup-status text-12-regular">
                            <Icon name="warning" size="small" />
                            {reason()}
                          </span>
                        )}
                      </Show>
                      <Show when={!item.alreadyConnected && probeReason(item.probe, "unknown")}>
                        {(reason) => <span class="setup-status text-12-regular">{reason()}</span>}
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          )}
        </Show>

        {/*
          Local-only: a verdict, not a form. Nothing was written, so there is no
          checkbox and nothing to undo. Every harness gets a row whether or not
          it was found — "Cursor: not signed in" is the answer for a user who
          expected Cursor to work, and deriving the list from what discovery
          returned would drop exactly that row.
        */}
        <Show when={confirmed()}>
          {(current) => (
            <div class="setup-block">
              <div class="setup-rows">
                <For each={localHarnessStatuses(current().rows)}>
                  {(harness) => (
                    <div class="setup-row" data-harness={harness.id} data-state={harness.state}>
                      <span class="setup-row-copy">
                        <span class="text-13-medium text-text-strong">{harness.label}</span>
                        <span class="setup-row-consequence text-12-regular">
                          {harnessDetail(harness)}
                        </span>
                      </span>
                      <Show when={harness.state === "working"}>
                        <span class="setup-verified text-12-regular">
                          <Icon name="circle-check" size="small" />
                          Ready
                        </span>
                      </Show>
                      <Show when={harness.state === "broken"}>
                        <span class="setup-status text-12-regular">
                          <Icon name="warning" size="small" />
                          Needs attention
                        </span>
                      </Show>
                      {/* Deliberately not a checkmark — see LocalHarnessStatus. */}
                      <Show when={harness.state === "unverifiable"}>
                        <span class="setup-status text-12-regular">Signed in</span>
                      </Show>
                      <Show when={harness.state === "missing"}>
                        <span class="setup-status text-12-regular">Not signed in</span>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
              <p class="text-12-regular text-text-weak">
                Nothing was saved. Sign out of a CLI and agents here lose that access too.
              </p>
              <Show when={localHarnessStatuses(current().rows).every((harness) => harness.state === "missing")}>
                <Button class="self-start" variant="secondary" onClick={() => props.onViewChange({ kind: "providers" })}>
                  Connect a provider instead
                </Button>
              </Show>
            </div>
          )}
        </Show>

        {/* The action sits with the thing it acts on. The footer is for moving
            between steps, so a button that WRITES cannot live there. */}
        <Show when={preview() && selectedCount() > 0}>
          <Button class="self-start" disabled={busy()} onClick={() => void saveDiscovered()}>
            {busy()
              ? "Saving…"
              : `Save ${selectedCount()} connection${selectedCount() === 1 ? "" : "s"}`}
          </Button>
        </Show>

        <Show when={state().phase === "saving"}>
          <div class="flex items-center gap-2 text-13-regular text-text-base">
            <Spinner />
            Saving and verifying with the provider…
          </div>
        </Show>

        {/* One row per LOGIN, each with its own verdict and its own repair —
            two harness bindings of one credential reported the same answer
            twice and read as two separate things to fix. */}
        <Show when={settled()}>
          {(current) => (
            <div class="setup-rows">
              <For each={groupConnectResults(current().results)}>
                {(result) => (
                  <div class="setup-row">
                    <span class="setup-row-copy">
                      <span class="text-13-medium text-text-strong">{connectionDisplayName(result.providerId)}</span>
                      <Show when={aiConnectFailureCopy(result.result)}>
                        {(copy) => <span class="setup-row-consequence text-12-regular">{copy()}</span>}
                      </Show>
                    </span>
                    <Show
                      when={isUsableResult(result.result)}
                      fallback={
                        <Button size="small" variant="ghost" onClick={() => props.onViewChange({ kind: "chooser" })}>
                          Retry
                        </Button>
                      }
                    >
                      <span class="setup-verified text-12-regular">
                        <Icon name="circle-check" size="small" />
                        Verified
                      </span>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          )}
        </Show>

        <Show when={error()}>
          {(failed) => (
            <div class="flex items-start gap-2 text-13-regular text-text-weak">
              <Icon name="warning" size="small" class="translate-y-px shrink-0" />
              <div>{failed().message}</div>
            </div>
          )}
        </Show>
      </Show>
    </div>
  )
}

export async function invalidateAIConnectQueries() {
  await queryClient.invalidateQueries({
    predicate: (query) => query.queryKey.includes("credentials") || query.queryKey[2] === "providers",
  })
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/** Narrows a probe to its reason, so the row renders copy rather than a state. */
function probeReason(probe: AIDiscoveryProbe | undefined, state: "broken" | "unknown") {
  if (probe?.state !== state) return
  return probe.reason || (state === "broken" ? "Won't work" : "Couldn't check")
}

/** A harness row's sub-line: what the user has, and what to do when they don't. */
function harnessDetail(harness: LocalHarnessStatus) {
  if (harness.state === "working") return "Ready to use."
  if (harness.state === "missing") return `Run \`${harness.signIn}\` to use it here.`
  // States what is and isn't established, without implying either.
  if (harness.state === "unverifiable") return `Signed in to ${harness.signIn} works here. We can't check it yet.`
  return harness.detail || "Sign in again to use it here."
}

/**
 * One login's sub-line. A merged row names the harness bindings it covers, so
 * "why is this one row when Claxedo runs two harnesses?" is answerable without
 * leaving the screen.
 */
function rowDescription(row: AIDiscoveryRow) {
  return [row.accountId, row.origin, row.bindings.length > 1 ? `Used by ${row.bindings.join(" and ")}` : undefined]
    .filter(Boolean)
    .join(" · ")
}

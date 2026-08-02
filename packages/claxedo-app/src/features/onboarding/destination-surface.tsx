import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { Spinner } from "@opencode-ai/ui/spinner"
import { TextField } from "@opencode-ai/ui/text-field"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { For, Show, createMemo, createSignal, onCleanup, type Component, type JSX } from "solid-js"
import type { OnboardingDestination } from "./ai-connect-state"
import { SandboxDriverLogo } from "./app-ports"
import {
  connectCodeHost,
  connectedCodeHosts,
  readCodeHostAttempt,
  type CodeHostRequest,
  type CodeHostStatus,
} from "./code-host-api"
import { destinationIncludesCloud, onboardingDestinationOptions } from "./destination"
import {
  canSaveSandboxProvider,
  saveSandboxProviderKey,
  type SandboxProviderCatalog,
  type SandboxProviderOption,
  type SandboxProviderVerification,
  type SandboxProviderWriter,
} from "./sandbox-provider-api"

export type DestinationSurfaceProps = {
  /** The current answer, when there is one. Re-entering the step shows it. */
  destination?: OnboardingDestination
  onChoose: (destination: OnboardingDestination) => void
  /** Everything the cloud answer needs, collected inline rather than in later steps. */
  sandboxCatalog?: SandboxProviderCatalog
  codeHosts?: CodeHostStatus
  loading?: boolean
  baseUrl?: string
  writeSandboxKey?: SandboxProviderWriter
  codeHostRequest?: CodeHostRequest
  sandboxAuthUrl?: (input: { baseUrl?: string; driverId: string }) => string
  onSandboxConfigured?: () => void | Promise<void>
  onCodeHostConnected?: () => void | Promise<void>
  /** Opens an OAuth URL; injectable so the flow is testable. */
  openUrl?: (url: string) => void
  /** Device-grant poll delay; injectable so tests drive the clock. */
  codeHostPollSleep?: (ms: number) => Promise<void>
  /** The project picker, shown when the answer is local — one folder, one action. */
  projectPicker?: JSX.Element
}

/**
 * The first question: whether to set up cloud sessions as well as local ones.
 *
 * Answering yes opens the two things the cloud actually needs — a provider key
 * and a repository to clone — right here, rather than deferring them to steps
 * the user would reach after committing. Answering no shows the project picker,
 * because a local run needs nothing else.
 */
export const DestinationSurface: Component<DestinationSurfaceProps> = (props) => {
  const wantsCloud = () => destinationIncludesCloud(props.destination)
  const answered = () => props.destination !== undefined

  return (
    <div class="setup-block" data-component="destination-surface" data-destination={props.destination ?? "unanswered"}>
      <div class="setup-rows">
        <For each={onboardingDestinationOptions}>
          {(option) => (
            <button
              type="button"
              class="setup-row"
              data-option={option.id}
              aria-pressed={props.destination === option.id}
              onClick={() => props.onChoose(option.id)}
            >
              <span class="setup-row-copy">
                <span class="text-13-medium text-text-strong">{option.label}</span>
                <span class="setup-row-consequence text-12-regular">{option.consequence}</span>
              </span>
              <Show
                when={props.destination === option.id}
                fallback={<Icon name="chevron-right" size="small" class="setup-row-chevron" />}
              >
                <Icon name="check" size="small" class="text-text-strong" />
              </Show>
            </button>
          )}
        </For>
      </div>

      {/* Yes opens its own requirements in place. Sending the user to a separate
          step for each would ask them to commit to the cloud before seeing what
          the cloud costs them. */}
      <Show when={answered() && wantsCloud()}>
        <div class="setup-block" data-section="cloud-setup">
          <SandboxKeyBlock
            catalog={props.sandboxCatalog}
            loading={props.loading}
            baseUrl={props.baseUrl}
            write={props.writeSandboxKey}
            authUrl={props.sandboxAuthUrl}
            onConfigured={props.onSandboxConfigured}
          />
          <CodeHostBlock
            status={props.codeHosts}
            loading={props.loading}
            request={props.codeHostRequest}
            openUrl={props.openUrl}
            onConnected={props.onCodeHostConnected}
            sleep={props.codeHostPollSleep}
          />
        </div>
      </Show>

      <Show when={answered() && !wantsCloud() && props.projectPicker}>
        {(picker) => <div data-section="project-picker">{picker()}</div>}
      </Show>

    </div>
  )
}

/** Logo + name, shared by the select's trigger and its menu rows. */
const ProviderLabel: Component<{ provider: SandboxProviderOption }> = (props) => (
  <span class="flex items-center gap-2 min-w-0">
    <SandboxDriverLogo id={props.provider.id} label={props.provider.label} class="size-4 shrink-0" />
    <span class="truncate">{props.provider.label}</span>
  </span>
)

/** The sandbox provider key, asked for where the cloud is chosen. */
const SandboxKeyBlock: Component<{
  catalog?: SandboxProviderCatalog
  loading?: boolean
  baseUrl?: string
  write?: SandboxProviderWriter
  authUrl?: (input: { baseUrl?: string; driverId: string }) => string
  onConfigured?: () => void | Promise<void>
}> = (props) => {
  const [picked, setPicked] = createSignal<string>()
  const [values, setValues] = createSignal<Record<string, string>>({})
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [saved, setSaved] = createSignal<SandboxProviderVerification>()

  const providers = () => props.catalog?.providers ?? []
  /**
   * What the user picked, else the one this machine can already use, else the
   * server's default. Opening on an unconfigured default while a configured
   * provider sits in the list would ask for a key the user does not need — the
   * default is a suggestion, not a statement about what works here.
   */
  const selected = createMemo<SandboxProviderOption | undefined>(() => {
    const id = picked()
    if (id) return providers().find((provider) => provider.id === id) ?? providers()[0]
    const fallback = providers().find((provider) => provider.id === props.catalog?.defaultProviderId)
    if (fallback?.configured) return fallback
    return providers().find((provider) => provider.configured) ?? fallback ?? providers()[0]
  })
  /**
   * What the provider said when the key was actually tried. "Ready" is now an
   * earned verdict, so a key that saved without being checkable says so instead
   * of claiming a readiness nobody proved.
   */
  const verdict = createMemo<SandboxProviderVerification | undefined>(
    () => saved() ?? selected()?.verification,
  )
  const configured = () => !!saved() || selected()?.configured === true
  const ready = createMemo(() => {
    const provider = selected()
    return !!provider && canSaveSandboxProvider(provider, values())
  })

  async function save() {
    const provider = selected()
    if (!provider || !ready() || !props.authUrl) return
    setBusy(true)
    setFailure(undefined)
    const outcome = await saveSandboxProviderKey({
      baseUrl: props.baseUrl,
      providerId: provider.id,
      values: Object.fromEntries(provider.fields.map((field) => [field.key, values()[field.key] ?? ""])),
      ...(props.write ? { write: props.write } : {}),
      authUrl: props.authUrl,
    })
    setBusy(false)
    if (!outcome.ok) {
      setFailure(outcome.reason)
      return
    }
    setSaved(outcome.verification ?? { state: "unknown" })
    setValues({})
    await props.onConfigured?.()
  }

  return (
    <div class="setup-block" data-section="sandbox-key">
      <span class="text-13-medium text-text-strong">Sandbox provider</span>

      <Show when={props.loading}>
        <div class="flex items-center gap-2 text-13-regular text-text-base">
          <Spinner />
          Loading sandbox providers…
        </div>
      </Show>

      <Show when={!props.loading && providers().length === 0}>
        <p class="text-12-regular text-text-weak">
          This server has no sandbox providers, so cloud sessions aren't available here yet.
        </p>
      </Show>

      {/* One provider runs your cloud sessions, so this is a picker rather than
          a list to scan — the same select the Settings screen uses, with the
          same brand marks and the same dot for a provider that already has a
          key. A row per provider pushed everything after it off the screen. */}
      <Show when={providers().length > 1}>
        <Select
          options={[...providers()]}
          current={selected()}
          value={(provider) => provider.id}
          label={(provider) => provider.label}
          renderValue={(provider) => <ProviderLabel provider={provider} />}
          onSelect={(provider) => {
            if (!provider) return
            setPicked(provider.id)
            setValues({})
            setFailure(undefined)
          }}
          variant="secondary"
          size="small"
          triggerVariant="settings"
          // The settings variant right-aligns for Settings' label–control rows;
          // standing alone here that reads as a bare left gap.
          triggerClass="!justify-start"
          triggerProps={{ "aria-label": "Sandbox provider" }}
        >
          {(provider) =>
            provider
              ? (
                <span class="flex items-center gap-2 min-w-0">
                  <ProviderLabel provider={provider} />
                  <Show when={provider.configured}>
                    <span aria-hidden="true" class="shrink-0 size-1.5 rounded-full bg-surface-success-strong" />
                  </Show>
                </span>
              )
              : null}
        </Select>
      </Show>

      <Show when={selected()}>
        {(provider) => (
          <Show
            when={!configured()}
            fallback={
              /*
                A tick is a claim, so it is spent only where the provider
                answered. A key that saved without a possible check gets the
                fact and the server's own sentence — Modal is permanently in
                that state (gRPC-only control plane), so this reads as a
                settled answer rather than something still in progress.
              */
              <Show
                when={verdict()?.state === "working"}
                fallback={
                  <span class="setup-row-copy">
                    <span class="text-12-regular text-text-base">
                      {provider().label} key saved. {verdict()?.reason ?? "Claxedo couldn't check it here."}
                    </span>
                  </span>
                }
              >
                <span class="setup-verified text-12-regular">
                  <Icon name="circle-check" size="small" />
                  {provider().label} is ready for cloud sessions
                </span>
              </Show>
            }
          >
            <div class="setup-block">
              {/* With one provider there is no picker to name it, and "an API
                  key" alone does not say whose. */}
              <Show when={providers().length === 1}>
                <p class="text-12-regular text-text-weak">
                  Cloud sessions run on {provider().label}.
                </p>
              </Show>
              <For each={provider().fields}>
                {(field) => (
                  <TextField
                    label={field.label}
                    type={field.secret ? "password" : "text"}
                    value={values()[field.key] ?? ""}
                    placeholder={field.label}
                    disabled={busy()}
                    onChange={(value: string) => setValues((current) => ({ ...current, [field.key]: value }))}
                  />
                )}
              </For>
              <p class="text-12-regular text-text-weak">
                Your key stays on this machine. Sandboxes bill to your {provider().label} account.
              </p>
              <Show when={failure()}>
                {(reason) => (
                  <div class="flex items-start gap-2 text-13-regular text-text-weak">
                    <Icon name="warning" size="small" class="mt-0.5 shrink-0" />
                    <div>{reason()}</div>
                  </div>
                )}
              </Show>
              <Button class="self-start" size="small" disabled={!ready() || busy()} onClick={() => void save()}>
                {busy() ? "Saving…" : "Save key"}
              </Button>
            </div>
          </Show>
        )}
      </Show>
    </div>
  )
}

/** How long a device code stays valid — GitHub's is 15 minutes. */
const DEVICE_GRANT_LIFETIME_MS = 15 * 60 * 1000

/** A device grant the user is partway through approving on the host's site. */
type PendingGrant = { url: string; attemptId: string; userCode?: string; intervalMs?: number }

/** The repository a cloud sandbox clones from. */
const CodeHostBlock: Component<{
  status?: CodeHostStatus
  loading?: boolean
  request?: CodeHostRequest
  openUrl?: (url: string) => void
  onConnected?: () => void | Promise<void>
  /** Injectable so tests drive the poll clock instead of waiting on it. */
  sleep?: (ms: number) => Promise<void>
}> = (props) => {
  const [secret, setSecret] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [grant, setGrant] = createSignal<PendingGrant>()
  const [tokenOpen, setTokenOpen] = createSignal(false)

  const integration = () => props.status?.integrations[0]
  const connected = createMemo(() => connectedCodeHosts(props.status ?? { integrations: [], connections: [] }))
  const prompt = () => integration()?.prompts.find((item) => item.secret) ?? integration()?.prompts[0]
  const usesOAuth = () => integration()?.methods.includes("oauth") === true
  const acceptsToken = () => (integration()?.prompts.length ?? 0) > 0

  onCleanup(() => setGrant(undefined))

  async function connect(method: "oauth" | "key") {
    const host = integration()
    if (!host || !props.request) return
    setBusy(true)
    setFailure(undefined)
    const outcome = await connectCodeHost({
      request: props.request,
      integrationId: host.id,
      method,
      ...(method === "key" ? { secret: secret() } : {}),
    })
    if (!outcome.ok) {
      setBusy(false)
      setFailure(outcome.reason)
      return
    }
    if ("oauth" in outcome && outcome.oauth) {
      // The user has to TYPE this code on the host's page — it cannot be
      // prefilled — so the code is shown before the page opens, not after.
      setGrant(outcome.oauth)
      props.openUrl?.(outcome.oauth.url)
      void awaitApproval(outcome.oauth)
      return
    }
    setBusy(false)
    setSecret("")
    await props.onConnected?.()
  }

  /**
   * A device grant has no callback, so the only way to learn the user approved
   * it is to keep asking. Each read also advances the grant server-side, so the
   * host's suggested interval is honoured rather than tightened.
   *
   * Bounded on purpose. A grant the user walks away from is never answered by
   * the host either, so an unbounded loop would poll until the tab closed;
   * the cap covers the ~15 minutes a device code stays valid and then says so.
   */
  async function awaitApproval(pending: PendingGrant) {
    const wait = props.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    const interval = pending.intervalMs ?? 5000
    const maxPolls = Math.ceil(DEVICE_GRANT_LIFETIME_MS / interval)
    for (let poll = 0; poll < maxPolls; poll++) {
      await wait(interval)
      // Cancelled, superseded, or unmounted while we were waiting.
      if (grant()?.attemptId !== pending.attemptId) return
      const outcome = await readCodeHostAttempt(props.request!, pending.attemptId)
      if (grant()?.attemptId !== pending.attemptId) return
      if (outcome.state === "pending") continue
      setGrant(undefined)
      setBusy(false)
      if (outcome.state === "failed") {
        setFailure(outcome.reason)
        return
      }
      await props.onConnected?.()
      return
    }
    if (grant()?.attemptId !== pending.attemptId) return
    setGrant(undefined)
    setBusy(false)
    setFailure("That code expired before it was approved. Start again to get a new one.")
  }

  return (
    <div class="setup-block" data-section="code-host">
      <span class="text-13-medium text-text-strong">Repository access</span>

      <Show when={props.loading}>
        <div class="flex items-center gap-2 text-13-regular text-text-base">
          <Spinner />
          Checking connected accounts…
        </div>
      </Show>

      <Show when={!props.loading && !integration()}>
        <p class="text-12-regular text-text-weak">
          This server has no code hosts to connect yet, so there's nothing for cloud sessions to clone.
        </p>
      </Show>

      <Show when={connected().length > 0}>
        <div class="setup-rows">
          <For each={connected()}>
            {(connection) => (
              <div class="setup-row" data-connection={connection.id}>
                <span class="setup-row-copy">
                  <span class="text-13-medium text-text-strong">
                    {connection.accountLabel ?? connection.integrationId}
                  </span>
                  <span class="setup-row-consequence text-12-regular">
                    {connection.status === "degraded"
                      ? "Connected, but this token needs reconnecting in Settings before clones will work."
                      : "Cloud sessions can clone this account's repositories."}
                  </span>
                </span>
                <span class="setup-verified text-12-regular">
                  <Icon name="circle-check" size="small" />
                  Connected
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* An existing connection is the answer — re-asking for a token when one
          already works would be asking the user to redo settled work. */}
      <Show when={integration() && connected().length === 0}>
        <div class="setup-block">
          <Show when={grant()}>
            {(pending) => (
              <div class="setup-block" data-section="device-code">
                <p class="text-13-regular text-text-base">
                  Enter this code on {integration()!.name} to finish connecting.
                </p>
                {/* The host asks the user to type this themselves — it cannot
                    be prefilled — so it is the loudest thing on the screen and
                    copyable rather than something to transcribe by eye. */}
                <Show when={pending().userCode}>
                  {(code) => <TextField label="Your code" value={code()} readOnly copyable />}
                </Show>
                <div class="flex items-center gap-3">
                  <Button size="small" variant="secondary" onClick={() => props.openUrl?.(pending().url)}>
                    Open {integration()!.name}
                  </Button>
                  <span class="flex items-center gap-2 text-12-regular text-text-weak">
                    <Spinner />
                    Waiting for you to approve it…
                  </span>
                </div>
              </div>
            )}
          </Show>

          <Show when={!grant()}>
            <Show
              when={usesOAuth()}
              fallback={
                <>
                  <p class="text-12-regular text-text-weak">
                    Connect {integration()!.name} so cloud sessions can clone your private repos. Paste a fine-grained
                    token — public repos need nothing.
                  </p>
                  <TextField
                    label={prompt()?.label ?? "Access token"}
                    type="password"
                    value={secret()}
                    disabled={busy()}
                    onChange={(value: string) => setSecret(value)}
                  />
                  <Button
                    class="self-start"
                    size="small"
                    disabled={busy() || secret().trim().length === 0}
                    onClick={() => void connect("key")}
                  >
                    {busy() ? "Connecting…" : `Connect ${integration()!.name}`}
                  </Button>
                </>
              }
            >
              <p class="text-12-regular text-text-weak">
                Connect {integration()!.name} so cloud sessions can clone your private repos.
              </p>
              <Button class="self-start" size="small" disabled={busy()} onClick={() => void connect("oauth")}>
                {busy() ? "Connecting…" : `Connect ${integration()!.name}`}
              </Button>

              {/* Signing in is the path most people want, so the token is a
                  way out rather than a second thing to weigh up front. */}
              <Show when={acceptsToken()}>
                <Show
                  when={tokenOpen()}
                  fallback={
                    <button
                      type="button"
                      class="self-start text-12-regular text-text-weak underline"
                      onClick={() => setTokenOpen(true)}
                    >
                      Prefer a token? Paste a fine-grained token instead.
                    </button>
                  }
                >
                  <TextField
                    label={prompt()?.label ?? "Access token"}
                    type="password"
                    value={secret()}
                    disabled={busy()}
                    onChange={(value: string) => setSecret(value)}
                  />
                  <Button
                    class="self-start"
                    size="small"
                    variant="secondary"
                    disabled={busy() || secret().trim().length === 0}
                    onClick={() => void connect("key")}
                  >
                    Use this token
                  </Button>
                </Show>
              </Show>
            </Show>
          </Show>

          <Show when={failure()}>
            {(reason) => (
              <div class="setup-block">
                <div class="flex items-start gap-2 text-13-regular text-text-weak">
                  <Icon name="warning" size="small" class="mt-0.5 shrink-0" />
                  <div>{reason()}</div>
                </div>
                <Show when={usesOAuth()}>
                  <Button class="self-start" size="small" variant="secondary" onClick={() => void connect("oauth")}>
                    Try again
                  </Button>
                </Show>
              </div>
            )}
          </Show>
        </div>
      </Show>
    </div>
  )
}

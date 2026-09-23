// The single provider-connect implementation. The command-palette dialog, the
// Models page's rows and the first-run wizard through them all render this;
// none owns a private copy of the method chooser, the OAuth flow or the
// API-key field.
//
// A new key is stored where the server keeps harness keys. A self-hosted node
// and the desktop's embedded server take it on the Claxedo credential route,
// under a label of the user's own; the hosted plane serves no credential route
// and keeps Pi's keys under its own `PUT /auth/:providerID?harness=pi`, an
// entry with no label to ask for. Which server this is comes from the health
// document the whole shell reads, never from a caller.

import type { ClaxedoProviderAuthorization as ProviderAuthAuthorization } from "@/platform/api/claxedo-api-types"
import type { ClaxedoProviderAuthMethod as ProviderAuthMethod } from "@/platform/api/claxedo-api-types"
import { Button } from "@opencode-ai/ui/button"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { Link } from "@/app/controls/link"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import { useLanguage } from "@/platform/i18n/provider"
import { useProviderAuth, useProviders } from "@/app/providers/use-providers"
import { useServerProduct } from "@/app/connection/server-product"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { claxedoCredentialRequest, putHostedProviderKey } from "@/platform/api/credential-request"
import { queryClient } from "@/platform/query/query-client"
import { errorMessage } from "@/lib/server-errors"
import {
  connectContextKey,
  connectSubject,
  connectVars,
  CONNECT_CONTEXT_COPY,
  type ConnectContext,
} from "@/platform/identity/harness-catalog"
import { connectMethodOptions, fallbackConnectMethods, type ConnectMethodOption } from "@/platform/identity/connect-methods"

export type ProviderConnectFormProps = {
  provider: string
  /** The harness whose credential store this writes to. */
  harness: string
  /**
   * What the card is setting up, in the words it shows. The registry's provider
   * id is a key, not a name — the model catalog has never heard of `claude-sdk`
   * and would render the id itself — so every sentence composes from here.
   */
  context: ConnectContext
  /**
   * The (workspace-or-directory) scope that harness is being configured for.
   * Omitted inside a workspace SDK scope, which resolves its own.
   */
  workspaceScope?: string
  /** Written with the credential so onboarding's scope choice is honoured. */
  scope?: "local" | "shared"
  /**
   * Replaces the token on this stored row instead of storing another account.
   * The row keeps its id, its name and its place in the accounts list, so the
   * harness is not silently moved onto a row the user did not choose.
   */
  credentialId?: string
  /** Runs after the credential is stored and the provider list is refreshed. */
  onConnected?: () => void | Promise<void>
  /** The surface's own teardown — dialog close, or step advance. */
  onDone?: () => void
  /** Hides the provider name row when the surface already shows a title. */
  hideHeading?: boolean
  /**
   * Opens on the first method so the card is never a dead end. Off by default:
   * a dialog opened on "connect something" waits for a pick.
   */
}

function useProviderConnectForm(props: ProviderConnectFormProps) {
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const localExecution = useServerProduct().localExecution
  const hosted = () => !localExecution()
  const providers = useProviders(() => props.harness, () => props.workspaceScope)
  // Auth belongs to the machine serving this scope, not to the harness name:
  // `useProviderAuth` reads it under the same (server, scope, harness) key the
  // catalog above uses, so a workspace reached through the relay never shows
  // the daemon's methods.
  const providerAuthQuery = useProviderAuth(() => props.harness, () => props.workspaceScope)
  /** The subject of every sentence on this card, and the name on its heading. */
  const subject = () => connectSubject(props.context)
  const contextKey = (base: string) => connectContextKey(base, props.context)
  const contextVars = () => connectVars(props.context)

  // Pi's `openai-codex` rides the Codex app-server's ChatGPT login: on a
  // machine that is the bundle's OAuth, and the hosted plane, with no machine
  // to sign in on, refuses a pasted key for it. So on the plane it has no
  // method at all, and the card says where it signs in instead.
  const codexBundleRequired = () => props.harness === "pi" && props.provider === "openai-codex"
  const authProviderID = () => codexBundleRequired() ? "codex-app-server" : props.provider
  const fallback = createMemo<ProviderAuthMethod[]>(() => {
    if (!codexBundleRequired()) return fallbackConnectMethods(props.provider)
    if (hosted()) return []
    return [{ type: "oauth", label: language.t("provider.connect.method.openai.plan.title") }]
  })
  // An empty list is as unusable as no answer at all: the card would offer
  // nothing to fill in, so both fall back to what the catalog knows is pasted.
  const served = () => providerAuthQuery.data?.[props.provider]
  const methods = createMemo(() => {
    const answered = served()
    return codexBundleRequired() || !answered?.length ? fallback() : answered
  })
  const options = createMemo(() => connectMethodOptions(props.provider, methods()))
  const [store, setStore] = createStore({
    methodIndex: undefined as number | undefined,
    authorization: undefined as ProviderAuthAuthorization | undefined,
    state: undefined as "pending" | "auto" | "code" | "error" | undefined,
    value: "",
    label: "",
    code: "",
    error: undefined as string | undefined,
    saving: false,
  })
  // A single method is not a choice, so it is simply the method. Two or more
  // stay unchosen until the reader picks one — preselecting put the first
  // method's fields on screen before they had read what the methods were.
  const selected = createMemo(() => {
    const list = options()
    if (store.methodIndex !== undefined) return list.find((option) => option.index === store.methodIndex)
    if (list.length === 1) return list.at(0)
    return undefined
  })
  /** A negative index withdraws the choice and puts the list back. */
  const pickMethod = (index: number) => {
    setStore({
      methodIndex: index < 0 ? undefined : index,
      authorization: undefined,
      state: undefined,
      error: undefined,
      value: "",
      code: "",
    })
  }
  const methodCopy = (option: ConnectMethodOption, part: "title" | "for" | "how") =>
    language.t(`${option.spec.copy}.${part}`, contextVars())
  /** Both a key and a subscription token are pasted; the stored secret's shape tells them apart. */
  const pastes = () => selected()?.type === "api" || selected()?.type === "token"

  // Every catalog entry for this harness, on whichever machine cached it: the
  // credential is stored centrally, so a machine that already answered for this
  // harness must re-ask.
  const markConnected = async () => {
    await queryClient.invalidateQueries({
      predicate: (query) => query.queryKey[2] === "providers" && query.queryKey[4] === props.harness,
    })
    await providers.load(props.provider).catch(() => undefined)
  }

  const complete = async () => {
    await markConnected()
    showToast({
      title: language.t("provider.connect.toast.connected.title", { vendor: contextVars().vendor }),
      description: language.t(contextKey(CONNECT_CONTEXT_COPY.connected), contextVars()),
    })
    await props.onConnected?.()
    props.onDone?.()
  }

  const fail = (err: unknown) => {
    setStore("state", "error")
    setStore("saving", false)
    setStore("error", errorMessage(err))
  }

  async function finishOAuth(code?: string) {
    if (store.methodIndex === undefined) return
    setStore("saving", true)
    setStore("error", undefined)
    try {
      await globalSDK.client.provider.oauth.callback({
        providerID: authProviderID(),
        method: store.methodIndex,
        ...(code ? { code } : {}),
      })
      await complete()
    } catch (err) {
      fail(err)
    }
  }

  async function startOAuth(index: number) {
    setStore({
      methodIndex: index,
      authorization: undefined,
      state: "pending",
      error: undefined,
      saving: true,
    })
    try {
      const result = await globalSDK.client.provider.oauth.authorize({
        providerID: authProviderID(),
        method: index,
      })
      const authorization = result.data ?? undefined
      if (!authorization) {
        await complete()
        return
      }
      setStore("authorization", authorization)
      setStore("state", authorization.method)
      setStore("saving", authorization.method === "auto")
      if (authorization.method === "auto") void finishOAuth()
    } catch (err) {
      fail(err)
    }
  }

  async function saveApiKey(e: SubmitEvent) {
    e.preventDefault()
    const apiKey = store.value.trim()
    if (!apiKey) {
      setStore("error", language.t("provider.connect.apiKey.required"))
      return
    }
    const label = store.label.trim()
    // Without a name of the user's own the row would be listed under the
    // provider id it is stored against, which names the binding rather than
    // the account and reads identically for every key they paste. The hosted
    // plane holds one key per provider and names nothing.
    if (!props.credentialId && !hosted() && !label) {
      setStore("error", language.t("provider.connect.label.required"))
      return
    }

    setStore("saving", true)
    setStore("error", undefined)
    try {
      if (props.credentialId) {
        await claxedoCredentialRequest({ credentialId: props.credentialId, action: "reconnect" }, {
          method: "POST",
          body: JSON.stringify({ secret: apiKey }),
        })
      } else if (hosted()) {
        await putHostedProviderKey({
          serverUrl: getClaxedoServerUrl(),
          providerId: props.provider,
          harness: props.harness,
          key: apiKey,
          ...(props.workspaceScope === undefined ? {} : { directory: props.workspaceScope }),
          request: authFetch,
        })
      } else {
        await claxedoCredentialRequest(undefined, {
          method: "PUT",
          body: JSON.stringify({
            provider_id: props.provider,
            kind: "api_key",
            // An unscoped save defaults to `managed`; onboarding passes a scope so
            // "this machine only" is stored as the user asked.
            source: props.scope === "local" ? "local_only" : "managed",
            ...(props.scope ? { scope: props.scope } : {}),
            label,
            secret: apiKey,
          }),
        })
      }
      await complete()
    } catch (err) {
      setStore("error", errorMessage(err))
    } finally {
      setStore("saving", false)
    }
  }

  return {
    subject,
    contextKey,
    contextVars,
    language,
    hosted,
    options,
    selected,
    methodCopy,
    pastes,
    pickMethod,
    store,
    setStore,
    startOAuth,
    finishOAuth,
    saveApiKey,
  }
}

export function ProviderConnectForm(props: ProviderConnectFormProps) {
  const form = useProviderConnectForm(props)
  const { store, setStore, language } = form
  const platform = usePlatform()
  const openLink = (url: string) => platform.openLink(url)
  const [copied, setCopied] = createSignal(false)
  let copiedTimer: ReturnType<typeof setTimeout> | undefined
  const copyCommand = async (command: string) => {
    await navigator.clipboard.writeText(command)
    setCopied(true)
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => setCopied(false), 1500)
  }
  onCleanup(() => clearTimeout(copiedTimer))
  const choosing = () => form.options().length > 1
  /** Nothing is chosen yet, so the only thing to draw is the choice. */
  const picking = () => choosing() && form.selected() === undefined

  return (
    <div class="flex flex-col gap-5">
      <Show when={!props.hideHeading}>
        <div class="flex items-center gap-3">
          <ProviderIcon id={props.provider} class="size-5 shrink-0 icon-strong-base" />
          <span class="text-14-medium text-text-strong">{form.subject()}</span>
        </div>
      </Show>

      {/*
        One step at a time. Every method's title, audience and instructions at
        once was four paragraphs the reader had to sort through before they
        could act; the choice is a list, and the instructions belong to the one
        they chose.
      */}
      <Show when={picking()}>
        <div class="flex flex-col gap-2">
          <span class="text-14-regular text-text-base">
            {language.t("provider.connect.selectMethod", { vendor: form.contextVars().vendor })}
          </span>
          <div class="flex flex-col gap-1" data-component="provider-connect-methods" role="radiogroup">
            <For each={form.options()}>
              {(option) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={false}
                  data-action="provider-connect-method"
                  data-method-type={option.type}
                  class="flex items-center justify-between gap-3 rounded-md border border-border-weak-base px-3 py-2.5 text-left transition-colors hover:border-border-strong-base hover:bg-surface-base-hover/35"
                  onClick={() => form.pickMethod(option.index)}
                >
                  <span class="flex min-w-0 flex-col gap-0.5">
                    <span data-slot="method-title" class="text-13-medium text-text-strong">{form.methodCopy(option, "title")}</span>
                    <span class="text-12-regular text-text-weak">{form.methodCopy(option, "for")}</span>
                  </span>
                  <Icon name="chevron-right" size="small" class="shrink-0 text-icon-weak-base" />
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/*
        The chosen method is context, not a heading. Stated bold above the
        instructions it outranked the one thing on the step that matters — the
        button — so it reads as a way back instead: quiet, small, and the whole
        row is the control.
      */}
      <Show when={!picking() && form.selected()}>
        {(option) => (
          <div class="flex flex-col gap-1.5" data-component="provider-connect-method" data-method-type={option().type}>
            <Show
              when={choosing()}
              fallback={(
                <span data-slot="method-title" class="text-12-regular text-text-weak">
                  {form.methodCopy(option(), "title")}
                </span>
              )}
            >
              <button
                type="button"
                class="-mx-1 flex w-fit items-center gap-1.5 rounded-md border-none bg-transparent px-1 py-0.5 text-12-regular text-text-weak transition-colors hover:text-text-base"
                data-action="provider-connect-change-method"
                onClick={() => form.pickMethod(-1)}
              >
                <Icon name="arrow-left" size="small" />
                <span data-slot="method-title">{form.methodCopy(option(), "title")}</span>
              </button>
            </Show>
            <span class="text-13-regular text-text-base">{form.methodCopy(option(), "how")}</span>
          </div>
        )}
      </Show>

      <Switch>
        <Match when={form.options().length === 0}>
          <p class="text-13-regular text-text-base" data-component="provider-connect-unavailable">
            {language.t("provider.connect.hosted.signsElsewhere", form.contextVars())}
          </p>
        </Match>
        <Match when={form.pastes()}>
          <form onSubmit={form.saveApiKey} class="flex flex-col items-start gap-4" data-method={form.selected()?.type ?? "api"}>
            {/* A command to run, not a field to fill: a bordered input with a
                copy affordance was read as somewhere to type. */}
            <Show when={form.selected()?.command}>
              {(command) => (
                <div class="flex w-full flex-col gap-1.5">
                  <span class="text-12-regular text-text-weak">{language.t("provider.connect.token.command")}</span>
                  <div class="flex items-center gap-2 rounded-md bg-surface-base px-3 py-2">
                    <code class="min-w-0 flex-1 truncate font-mono text-13-regular text-text-strong">{command()}</code>
                    <IconButton
                      icon={copied() ? "check-small" : "copy"}
                      variant="ghost"
                      aria-label={language.t("provider.connect.token.copyCommand")}
                      data-action="provider-connect-copy-command"
                      onClick={() => void copyCommand(command())}
                    />
                  </div>
                </div>
              )}
            </Show>
            <Show when={form.selected()?.spec.url}>
              {(url) => (
                <Button
                  class="w-auto"
                  type="button"
                  size="large"
                  variant="secondary"
                  data-action="provider-connect-open-key-page"
                  onClick={() => openLink(url())}
                >
                  <span class="flex items-center gap-1.5">
                    {language.t("provider.connect.method.openKeyPage")}
                    <Icon name="open-external" size="small" />
                  </span>
                </Button>
              )}
            </Show>
            <TextField
              autofocus
              type="text"
              label={form.selected()?.type === "token"
                ? language.t("provider.connect.token.label", { vendor: form.contextVars().vendor })
                : language.t("provider.connect.apiKey.label", { vendor: form.contextVars().vendor })}
              placeholder={form.selected()?.type === "token"
                ? language.t("provider.connect.token.placeholder")
                : language.t("provider.connect.apiKey.placeholder")}
              name="apiKey"
              value={store.value}
              onChange={(value) => setStore("value", value)}
              validationState={store.error ? "invalid" : undefined}
              error={store.error}
            />
            <Show when={!props.credentialId && !form.hosted()}>
              <TextField
                type="text"
                label={language.t("provider.connect.label.label")}
                placeholder={language.t("provider.connect.label.placeholder")}
                name="accountLabel"
                value={store.label}
                onChange={(value) => setStore("label", value)}
              />
            </Show>
            <Button class="w-auto" type="submit" size="large" variant="primary" disabled={store.saving}>
              {language.t("common.continue")}
            </Button>
          </form>
        </Match>
        <Match when={store.state === "pending"}>
          <div class="text-14-regular text-text-base flex items-center gap-2">
            <Spinner />
            <span>{language.t("provider.connect.status.inProgress")}</span>
          </div>
        </Match>
        <Match when={store.state === "auto" && store.authorization}>
          <div class="flex flex-col gap-4 text-14-regular text-text-base">
            <div>
              {language.t("provider.connect.oauth.auto.visit.prefix")}
              <Link href={store.authorization!.url}>{language.t("provider.connect.oauth.auto.visit.link")}</Link>
              {language.t(form.contextKey(CONNECT_CONTEXT_COPY.autoVisitSuffix), form.contextVars())}
            </div>
            <TextField
              label={language.t("provider.connect.oauth.auto.confirmationCode")}
              value={store.authorization!.instructions.replace(/^Enter code:\s*/i, "")}
              readOnly
              copyable
            />
            <div class="flex items-center gap-2">
              <Spinner />
              <span>{language.t("provider.connect.status.waiting")}</span>
            </div>
            <Switch>
              <Match when={store.error}>
                <div class="text-14-regular text-icon-critical-base">{store.error}</div>
              </Match>
            </Switch>
          </div>
        </Match>
        <Match when={store.state === "code" && store.authorization}>
          <form
            class="flex flex-col items-start gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              void form.finishOAuth(store.code.trim())
            }}
          >
            <div class="text-14-regular text-text-base">
              {language.t("provider.connect.oauth.code.visit.prefix")}
              <Link href={store.authorization!.url}>{language.t("provider.connect.oauth.code.visit.link")}</Link>
              {language.t(form.contextKey(CONNECT_CONTEXT_COPY.codeVisitSuffix), form.contextVars())}
            </div>
            <TextField
              autofocus
              type="text"
              label={language.t("provider.connect.oauth.code.label", { method: form.selected()?.label ?? "" })}
              placeholder={language.t("provider.connect.oauth.code.placeholder")}
              value={store.code}
              onChange={(value) => setStore("code", value)}
              validationState={store.error ? "invalid" : undefined}
              error={store.error}
            />
            <Button class="w-auto" type="submit" size="large" variant="primary" disabled={store.saving}>
              {language.t("common.continue")}
            </Button>
          </form>
        </Match>
        <Match when={store.state === "error"}>
          <div class="text-14-regular text-icon-critical-base">{store.error}</div>
        </Match>
        <Match when={form.selected()?.type === "oauth"}>
          <div class="flex items-center gap-3">
            <Button
              class="w-auto"
              type="button"
              size="large"
              variant="primary"
              disabled={store.saving}
              data-action="provider-connect-oauth-start"
              onClick={() => void form.startOAuth(form.selected()!.index)}
            >
              {language.t("provider.connect.oauth.start")}
            </Button>
            <span class="text-12-regular text-text-weak">{language.t("provider.connect.oauth.hint")}</span>
          </div>
        </Match>
      </Switch>
    </div>
  )
}

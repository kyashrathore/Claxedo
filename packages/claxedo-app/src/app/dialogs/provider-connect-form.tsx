// The single provider-connect implementation. Both the command-palette dialog
// and the onboarding setup page render this; neither owns a private copy of the
// method chooser, the OAuth flow, or the API-key field.
//
// The only real difference between the two callers is credential scope —
// onboarding writes a scoped credential so the user's "this machine only"
// choice is honoured — so that is a prop, not a fork.

import type { ClaxedoProviderAuthorization as ProviderAuthAuthorization } from "@/platform/api/claxedo-api-types"
import type { ClaxedoProviderAuthMethod as ProviderAuthMethod } from "@/platform/api/claxedo-api-types"
import { Button } from "@opencode-ai/ui/button"
import { List } from "@opencode-ai/ui/list"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { createMemo, For, Match, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { Link } from "@/app/controls/link"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import { useLanguage } from "@/platform/i18n/provider"
import { useProviderAuth, useProviders } from "@/app/providers/use-providers"
import { claxedoCredentialRequest } from "@/platform/api/credential-request"
import { queryClient } from "@/platform/query/query-client"
import { errorMessage } from "@/lib/server-errors"

export type ProviderConnectFormProps = {
  provider: string
  /** The harness whose credential store this writes to. */
  harness: string
  /**
   * The (workspace-or-directory) scope that harness is being configured for.
   * Omitted inside a workspace SDK scope, which resolves its own.
   */
  workspaceScope?: string
  /** Written with the credential so onboarding's scope choice is honoured. */
  scope?: "local" | "shared"
  /** Runs after the credential is stored and the provider list is refreshed. */
  onConnected?: () => void | Promise<void>
  /** The surface's own teardown — dialog close, or step advance. */
  onDone?: () => void
  /** Hides the provider name row when the surface already shows a title. */
  hideHeading?: boolean
  /**
   * How several methods are offered: a list the user picks from once, or a
   * segmented control that stays on screen so the choice can be changed. The
   * segmented form starts on the first method; OAuth waits for a click.
   */
  methodPicker?: "list" | "segmented"
}

function useProviderConnectForm(props: ProviderConnectFormProps) {
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const providers = useProviders(() => props.harness, () => props.workspaceScope)
  // Auth belongs to the machine serving this scope, not to the harness name:
  // `useProviderAuth` reads it under the same (server, scope, harness) key the
  // catalog above uses, so a cloud workspace never shows the daemon's methods.
  const providerAuthQuery = useProviderAuth(() => props.harness, () => props.workspaceScope)
  // The catalog holds model providers; callers may pass an id it does not carry
  // (an auth-only harness id, or a provider list that hasn't loaded yet).
  // Every consumer below reads `.name`, so this falls back to the id rather
  // than crash.
  const provider = createMemo(() =>
    providers.all().get(props.provider)
      ?? { id: props.provider, name: props.provider, source: "custom" as const, env: [], options: {}, models: {} },
  )
  const codexBundleRequired = () => props.harness === "pi" && props.provider === "openai-codex"
  const authProviderID = () => codexBundleRequired() ? "codex-app-server" : props.provider
  const fallback = createMemo<ProviderAuthMethod[]>(() => codexBundleRequired()
    ? [{ type: "oauth", label: "ChatGPT Plus or Pro" }]
    : [{ type: "api", label: language.t("provider.connect.method.apiKey") }])
  const methods = createMemo(() => codexBundleRequired()
    ? fallback()
    : providerAuthQuery.data?.[props.provider] ?? fallback())
  const apiMethodIndex = createMemo(() => methods().findIndex((item) => item.type === "api"))
  const [store, setStore] = createStore({
    methodIndex: undefined as number | undefined,
    authorization: undefined as ProviderAuthAuthorization | undefined,
    state: undefined as "pending" | "auto" | "code" | "error" | undefined,
    value: "",
    code: "",
    error: undefined as string | undefined,
    saving: false,
  })
  // A single method needs no choice; a segmented picker starts on the first.
  const selected = createMemo(() => {
    const list = methods()
    if (store.methodIndex !== undefined) return list.at(store.methodIndex)
    if (list.length === 1 || props.methodPicker === "segmented") return list[0]
    return undefined
  })
  const selectedIndex = () => store.methodIndex ?? (selected() ? methods().indexOf(selected()!) : undefined)
  const pickMethod = (index: number) => {
    setStore({ methodIndex: index, authorization: undefined, state: undefined, error: undefined, value: "", code: "" })
  }
  const methodLabel = (value?: { type?: string; label?: string }) =>
    value?.type === "api" ? language.t("provider.connect.method.apiKey") : value?.label ?? ""
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
    const name = provider().name
    showToast({
      title: language.t("provider.connect.toast.connected.title", { provider: name }),
      description: language.t("provider.connect.toast.connected.description", { provider: name }),
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

    setStore("saving", true)
    setStore("error", undefined)
    try {
      await claxedoCredentialRequest(undefined, {
        method: "PUT",
        body: JSON.stringify({
          provider_id: props.provider,
          kind: "api_key",
          // An unscoped save defaults to `managed`; onboarding passes a scope so
          // "this machine only" is stored as the user asked.
          source: props.scope === "local" ? "local_only" : "managed",
          ...(props.scope ? { scope: props.scope } : {}),
          label: provider().name,
          secret: apiKey,
        }),
      })
      await complete()
    } catch (err) {
      setStore("error", errorMessage(err))
    } finally {
      setStore("saving", false)
    }
  }

  return {
    provider,
    language,
    methods,
    apiMethodIndex,
    selected,
    methodLabel,
    pastes,
    selectedIndex,
    pickMethod,
    store,
    setStore,
    codexBundleRequired,
    startOAuth,
    finishOAuth,
    saveApiKey,
  }
}

export function ProviderConnectForm(props: ProviderConnectFormProps) {
  const form = useProviderConnectForm(props)
  const { store, setStore, language } = form

  return (
    <div class="flex flex-col gap-6">
      <Show when={!props.hideHeading}>
        <div class="flex items-center gap-3">
          <ProviderIcon id={form.provider().id} class="size-5 shrink-0 icon-strong-base" />
          <span class="text-14-medium text-text-strong">{form.provider().name}</span>
        </div>
      </Show>
      <Show when={props.methodPicker === "segmented" && form.methods().length > 1}>
        <div style={{ display: "inline-flex", padding: "2px", "border-radius": "8px", gap: "2px" }} class="bg-surface-raised-base" role="tablist" data-component="provider-connect-methods">
          <For each={form.methods()}>
            {(item, index) => (
              <button
                type="button"
                role="tab"
                aria-selected={form.selectedIndex() === index()}
                data-action="provider-connect-method"
                class="text-13-medium h-7 px-3 rounded-md border"
                classList={{
                  "bg-surface-raised-stronger-non-alpha border-border-strong-base text-text-strong": form.selectedIndex() === index(),
                  "border-transparent text-text-base hover:text-text-strong": form.selectedIndex() !== index(),
                }}
                onClick={() => form.pickMethod(index())}
              >
                {form.methodLabel(item)}
              </button>
            )}
          </For>
        </div>
      </Show>
      <Switch>
        <Match when={form.pastes() || form.apiMethodIndex() === 0}>
          <form onSubmit={form.saveApiKey} class="flex flex-col items-start gap-4" data-method={form.selected()?.type ?? "api"}>
            <div class="text-14-regular text-text-base">
              {form.selected()?.type === "token"
                ? language.t("provider.connect.token.description", { provider: form.provider().name })
                : language.t("provider.connect.apiKey.description", { provider: form.provider().name })}
            </div>
            <Show when={form.selected()?.type === "token" ? form.selected()?.command : undefined}>
              {(command) => <TextField label={language.t("provider.connect.token.command")} value={command()} readOnly copyable />}
            </Show>
            <TextField
              autofocus
              type="text"
              label={form.selected()?.type === "token"
                ? language.t("provider.connect.token.label", { provider: form.provider().name })
                : language.t("provider.connect.apiKey.label", { provider: form.provider().name })}
              placeholder={form.selected()?.type === "token"
                ? language.t("provider.connect.token.placeholder")
                : language.t("provider.connect.apiKey.placeholder")}
              name="apiKey"
              value={store.value}
              onChange={(value) => setStore("value", value)}
              validationState={store.error ? "invalid" : undefined}
              error={store.error}
            />
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
              {language.t("provider.connect.oauth.auto.visit.suffix", { provider: form.provider().name })}
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
              {language.t("provider.connect.oauth.code.visit.suffix", { provider: form.provider().name })}
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
        <Match when={props.methodPicker === "segmented" && form.selected()?.type === "oauth"}>
          <div class="flex flex-col items-start gap-4">
            <p class="text-14-regular text-text-base max-w-md text-pretty">
              {language.t("provider.connect.oauth.description", { method: form.selected()?.label ?? "", provider: form.provider().name })}
            </p>
            <div class="flex items-center gap-3">
              <Button class="w-auto" type="button" size="large" variant="primary" disabled={store.saving} data-action="provider-connect-oauth-start" onClick={() => void form.startOAuth(form.selectedIndex() ?? 0)}>
                {language.t("provider.connect.oauth.start")}
              </Button>
              <span class="text-12-regular text-text-weak">{language.t("provider.connect.oauth.hint")}</span>
            </div>
          </div>
        </Match>
        <Match when={form.codexBundleRequired()}>
          <div class="flex flex-col items-start gap-4">
            <div class="flex flex-col gap-1.5">
              <div class="text-14-medium text-text-strong text-balance">
                Use your ChatGPT account
              </div>
              <div class="max-w-md text-14-regular text-text-base text-pretty">
                Sign in to use your ChatGPT Plus or Pro Codex access with Pi. Claxedo stores the resulting token in its credential vault.
              </div>
            </div>
            <Button
              class="w-auto transition-transform duration-150 ease-out active:scale-[0.96]"
              type="button"
              size="large"
              variant="primary"
              disabled={store.saving}
              onClick={() => void form.startOAuth(0)}
            >
              Sign in with ChatGPT
            </Button>
          </div>
        </Match>
        <Match when={true}>
          <div class="text-14-regular text-text-base">
            {language.t("provider.connect.selectMethod", { provider: form.provider().name })}
          </div>
          <List
            items={form.methods}
            // A method the catalog did not name still needs a key, and the two
            // kinds are never listed twice.
            key={(item) => item?.label ?? item?.type ?? ""}
            onSelect={(item, index) => {
              if (!item) return
              if (item.type === "oauth") {
                void form.startOAuth(index)
                return
              }
              setStore("methodIndex", index)
            }}
          >
            {(item) => (
              <div class="w-full flex items-center gap-x-2">
                <span>{form.methodLabel(item)}</span>
              </div>
            )}
          </List>
        </Match>
      </Switch>
    </div>
  )
}

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
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { createMemo, For, Match, Show, Switch, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { Link } from "@/app/controls/link"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import { useLanguage } from "@/platform/i18n/provider"
import { useProviderAuth, useProviders } from "@/app/providers/use-providers"
import { claxedoCredentialRequest } from "@/platform/api/credential-request"
import { queryClient } from "@/platform/query/query-client"
import { errorMessage } from "@/lib/server-errors"
import { connectSubject, connectVars, type ConnectContext } from "@/platform/identity/harness-catalog"
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
  preselectFirstMethod?: boolean
}

function useProviderConnectForm(props: ProviderConnectFormProps) {
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const providers = useProviders(() => props.harness, () => props.workspaceScope)
  // Auth belongs to the machine serving this scope, not to the harness name:
  // `useProviderAuth` reads it under the same (server, scope, harness) key the
  // catalog above uses, so a cloud workspace never shows the daemon's methods.
  const providerAuthQuery = useProviderAuth(() => props.harness, () => props.workspaceScope)
  /** The subject of every sentence on this card, and the name on its heading. */
  const subject = () => connectSubject(props.context)
  const contextKey = (base: string) => `${base}.${props.context.kind}`
  const contextVars = () => connectVars(props.context)

  const codexBundleRequired = () => props.harness === "pi" && props.provider === "openai-codex"
  const authProviderID = () => codexBundleRequired() ? "codex-app-server" : props.provider
  const fallback = createMemo<ProviderAuthMethod[]>(() => codexBundleRequired()
    ? [{ type: "oauth", label: language.t("provider.connect.method.openai.plan.title") }]
    : fallbackConnectMethods(props.provider))
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
  // A single method is not a choice, and a segmented picker opens on the first.
  const selected = createMemo(() => {
    const list = options()
    if (store.methodIndex !== undefined) return list.find((option) => option.index === store.methodIndex)
    if (list.length === 1 || props.preselectFirstMethod === true) return list.at(0)
    return undefined
  })
  const pickMethod = (index: number) => {
    setStore({ methodIndex: index, authorization: undefined, state: undefined, error: undefined, value: "", code: "" })
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
      description: language.t(contextKey("provider.connect.toast.connected.description"), contextVars()),
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
    // the account and reads identically for every key they paste.
    if (!props.credentialId && !label) {
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
  const choosing = () => form.options().length > 1

  /** Title, who the method is for, and how to obtain it — the same three lines whether or not it is a choice. */
  const MethodBody: Component<{ option: ConnectMethodOption }> = (self) => (
    <>
      <span class="text-13-medium text-text-strong">{form.methodCopy(self.option, "title")}</span>
      <span class="text-12-regular text-text-base">{form.methodCopy(self.option, "for")}</span>
      <span class="text-12-regular text-text-weak">{form.methodCopy(self.option, "how")}</span>
    </>
  )

  return (
    <div class="flex flex-col gap-6">
      <Show when={!props.hideHeading}>
        <div class="flex items-center gap-3">
          <ProviderIcon id={props.provider} class="size-5 shrink-0 icon-strong-base" />
          <span class="text-14-medium text-text-strong">{form.subject()}</span>
        </div>
      </Show>

      <div class="flex flex-col gap-3">
        <div class="text-13-regular text-text-weak">
          {language.t(form.contextKey("provider.connect.context"), form.contextVars())}
        </div>
        <Show when={choosing()}>
          <div class="text-14-regular text-text-base">
            {language.t("provider.connect.selectMethod", { vendor: form.contextVars().vendor })}
          </div>
        </Show>
        <div
          class="flex flex-col gap-2"
          data-component="provider-connect-methods"
          role={choosing() ? "radiogroup" : undefined}
        >
          <For each={form.options()}>
            {(option) => (
              <Show
                when={choosing()}
                fallback={(
                  <div
                    class="flex flex-col gap-1 rounded-md border border-border-weak-base p-3 text-left"
                    data-component="provider-connect-method"
                    data-method-type={option.type}
                  >
                    <MethodBody option={option} />
                  </div>
                )}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={form.selected()?.index === option.index}
                  data-action="provider-connect-method"
                  data-method-type={option.type}
                  class="flex flex-col gap-1 rounded-md border p-3 text-left"
                  classList={{
                    "bg-surface-raised-base border-border-strong-base": form.selected()?.index === option.index,
                    "border-border-weak-base hover:border-border-strong-base": form.selected()?.index !== option.index,
                  }}
                  onClick={() => form.pickMethod(option.index)}
                >
                  <MethodBody option={option} />
                </button>
              </Show>
            )}
          </For>
        </div>
      </div>

      <Switch>
        <Match when={form.pastes()}>
          <form onSubmit={form.saveApiKey} class="flex flex-col items-start gap-4" data-method={form.selected()?.type ?? "api"}>
            <Show when={form.selected()?.command}>
              {(command) => <TextField label={language.t("provider.connect.token.command")} value={command()} readOnly copyable />}
            </Show>
            <Show when={form.selected()?.spec.url}>
              {(url) => <Link href={url()}>{language.t("provider.connect.method.openKeyPage")}</Link>}
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
            <Show when={!props.credentialId}>
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
              {language.t(form.contextKey("provider.connect.oauth.auto.visit.suffix"), form.contextVars())}
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
              {language.t(form.contextKey("provider.connect.oauth.code.visit.suffix"), form.contextVars())}
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

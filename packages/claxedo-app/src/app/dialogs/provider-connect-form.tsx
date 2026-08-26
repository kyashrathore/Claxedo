import { storePath } from "solid-js"
// The single provider-connect implementation. Both the command-palette dialog
// and the onboarding setup page render this; neither owns a private copy of the
// method chooser, the OAuth flow, or the API-key field.
//
// The only real difference between the two callers is credential scope —
// onboarding writes a scoped credential so the user's "this machine only"
// choice is honoured — so that is a prop, not a fork.

import type { ProviderAuthAuthorization, ProviderAuthMethod } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { List } from "@opencode-ai/ui/list"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { TextField } from "@opencode-ai/ui/text-field"
import { createMemo, Match, Show, Switch } from "solid-js"
import { createStore } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { Link } from "@/app/controls/link"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import { useShellQueryOptions as useQueryOptions } from "@/app/integrations/sync/query-options"
import { useLanguage } from "@/platform/i18n/provider"
import { mergeProviderQuery, useProviders } from "@/app/providers/use-providers"
import { claxedoCredentialRequest } from "@/platform/api/credential-request"
import { queryClient } from "@/platform/query/query-client"

export type ProviderConnectFormProps = {
  provider: string
  harness?: string
  /** Written with the credential so onboarding's scope choice is honoured. */
  scope?: "local" | "shared"
  /** Runs after the credential is stored and the provider list is refreshed. */
  onConnected?: () => void | Promise<void>
  /** The surface's own teardown — dialog close, or step advance. */
  onDone?: () => void
  /** Hides the provider name row when the surface already shows a title. */
  hideHeading?: boolean
}

export function useProviderConnectForm(props: ProviderConnectFormProps) {
  const globalSDK = useGlobalSDK()
  const queryOptions = useQueryOptions()
  const language = useLanguage()
  const providers = useProviders(props.harness)
  const providerAuthQuery = useQuery(() => queryOptions.providerAuth(props.harness))
  // The catalog holds MODEL providers; callers may pass an id it does not carry
  // (an auth-only id like `codex-acp`, or a provider the list hasn't loaded
  // yet). Every consumer below reads `.name`, so a miss used to throw and take
  // the whole screen with it — fall back to the id rather than crash.
  const provider = createMemo(
    () =>
      providers.all().get(props.provider) ?? {
        id: props.provider,
        name: props.provider,
        source: "custom" as const,
        env: [],
        options: {},
        models: {},
      },
  )
  const codexBundleRequired = () => props.harness === "pi" && props.provider === "openai-codex"
  const authProviderID = () => (codexBundleRequired() ? "codex-acp" : props.provider)
  const fallback = createMemo<ProviderAuthMethod[]>(() =>
    codexBundleRequired()
      ? [{ type: "oauth", label: "ChatGPT Plus or Pro" }]
      : [{ type: "api", label: language.t("provider.connect.method.apiKey") }],
  )
  const methods = createMemo(() =>
    codexBundleRequired() ? fallback() : (providerAuthQuery.data?.[props.provider] ?? fallback()),
  )
  const apiMethodIndex = createMemo(() => methods().findIndex((item) => item.type === "api"))
  const [store, setStore] = createStore({
    methodIndex: methods().length === 1 ? 0 : (undefined as number | undefined),
    authorization: undefined as ProviderAuthAuthorization | undefined,
    state: undefined as "pending" | "auto" | "code" | "error" | undefined,
    value: "",
    code: "",
    error: undefined as string | undefined,
    saving: false,
  })
  const selected = createMemo(() => (store.methodIndex === undefined ? undefined : methods().at(store.methodIndex)))
  const methodLabel = (value?: { type?: string; label?: string }) =>
    value?.type === "api" ? language.t("provider.connect.method.apiKey") : (value?.label ?? "")

  const markConnected = async () => {
    if (props.harness) {
      await queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[2] === "providers" && query.queryKey[4] === props.harness,
      })
      await providers.load(props.provider).catch(() => undefined)
      return
    }
    const current = provider()
    mergeProviderQuery({
      queryKey: queryOptions.providers(null).queryKey,
      current: providers.state(),
      providerId: props.provider,
      provider: { ...current, source: "api" },
      ensureConnected: true,
    })
    await queryClient.invalidateQueries({
      predicate: (query) => query.queryKey[2] === "providers" && query.queryKey[4] !== "pi",
    })
    await providers.load(props.provider).catch(() => undefined)
  }

  const complete = async () => {
    await markConnected()
    await props.onConnected?.()
    await globalSDK.client.global.dispose().catch(() => undefined)
    props.onDone?.()
  }

  const fail = (err: unknown) => {
    setStore(storePath("state", "error"))
    setStore(storePath("saving", false))
    setStore(storePath("error", err instanceof Error ? err.message : String(err)))
  }

  async function finishOAuth(code?: string) {
    if (store.methodIndex === undefined) return
    setStore(storePath("saving", true))
    setStore(storePath("error", undefined))
    try {
      await globalSDK.client.provider.oauth.callback(
        {
          providerID: authProviderID(),
          method: store.methodIndex,
          ...(code ? { code } : {}),
        },
        { throwOnError: true },
      )
      await complete()
    } catch (err) {
      fail(err)
    }
  }

  async function startOAuth(index: number) {
    setStore((state) => {
      Object.assign(state, {
        methodIndex: index,
        authorization: undefined,
        state: "pending",
        error: undefined,
        saving: true,
      })
    })
    try {
      const result = await globalSDK.client.provider.oauth.authorize(
        {
          providerID: authProviderID(),
          method: index,
        },
        { throwOnError: true },
      )
      const authorization = result.data ?? undefined
      if (!authorization) {
        await complete()
        return
      }
      setStore(storePath("authorization", authorization))
      setStore(storePath("state", authorization.method))
      setStore(storePath("saving", authorization.method === "auto"))
      if (authorization.method === "auto") void finishOAuth()
    } catch (err) {
      fail(err)
    }
  }

  async function saveApiKey(e: SubmitEvent) {
    e.preventDefault()
    const apiKey = store.value.trim()
    if (!apiKey) {
      setStore(storePath("error", language.t("provider.connect.apiKey.required")))
      return
    }

    setStore(storePath("saving", true))
    setStore(storePath("error", undefined))
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
      setStore(storePath("error", err instanceof Error ? err.message : String(err)))
    } finally {
      setStore(storePath("saving", false))
    }
  }

  return {
    provider,
    language,
    methods,
    apiMethodIndex,
    selected,
    methodLabel,
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
      <Switch>
        <Match when={form.selected()?.type === "api" || form.apiMethodIndex() === 0}>
          <form onSubmit={form.saveApiKey} class="flex flex-col items-start gap-4">
            <div class="text-14-regular text-text-base">
              {language.t("provider.connect.apiKey.description", { provider: form.provider().name })}
            </div>
            <TextField
              autofocus
              type="text"
              label={language.t("provider.connect.apiKey.label", { provider: form.provider().name })}
              placeholder={language.t("provider.connect.apiKey.placeholder")}
              name="apiKey"
              value={store.value}
              onChange={(value) => setStore(storePath("value", value))}
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
              readonly
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
              onChange={(value) => setStore(storePath("code", value))}
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
        <Match when={form.codexBundleRequired()}>
          <div class="flex flex-col items-start gap-4">
            <div class="flex flex-col gap-1.5">
              <div class="text-14-medium text-text-strong text-balance">Use your ChatGPT account</div>
              <div class="max-w-md text-14-regular text-text-base text-pretty">
                Sign in to use your ChatGPT Plus or Pro Codex access with Pi. Claxedo stores the resulting token in its
                credential vault.
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
            key={(item) => item?.label}
            onSelect={(item, index) => {
              if (!item) return
              if (item.type === "oauth") {
                void form.startOAuth(index)
                return
              }
              setStore(storePath("methodIndex", index))
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

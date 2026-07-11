// Claxedo stores provider credentials in the control plane, so this dialog connects API keys and OAuth through Claxedo-owned credential routes.

import type { ProviderAuthAuthorization, ProviderAuthMethod } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { createMemo, Match, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useQuery } from "@tanstack/solid-query"
import type { NormalizedProviderListResponse } from "@claxedo/session-client"
import { Link } from "@/components/link"
import { useGlobalSDK } from "@/context/global-sdk"
import { useShellQueryOptions as useQueryOptions } from "@claxedo/shell/data/query-options"
import { useLanguage } from "@claxedo/context/language"
import { useProviders } from "@claxedo/context/use-providers"
import { claxedoCredentialRequest } from "../../utils/credential-request"
import { queryClient } from "../../shared/query/query-client"

export function DialogConnectProvider(props: { provider: string }) {
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const queryOptions = useQueryOptions()
  const language = useLanguage()
  const providers = useProviders()
  const providerAuthQuery = useQuery(() => queryOptions.providerAuth())
  const provider = createMemo(() => providers.all().get(props.provider)!)
  const fallback = createMemo<ProviderAuthMethod[]>(() => [
    { type: "api", label: language.t("provider.connect.method.apiKey") },
  ])
  const methods = createMemo(() => providerAuthQuery.data?.[props.provider] ?? fallback())
  const apiMethodIndex = createMemo(() => methods().findIndex((item) => item.type === "api"))
  const [store, setStore] = createStore({
    methodIndex: methods().length === 1 ? 0 : undefined as number | undefined,
    authorization: undefined as ProviderAuthAuthorization | undefined,
    state: undefined as "pending" | "auto" | "code" | "error" | undefined,
    value: "",
    code: "",
    error: undefined as string | undefined,
    saving: false,
  })
  const selected = createMemo(() => store.methodIndex === undefined ? undefined : methods().at(store.methodIndex))
  const methodLabel = (value?: { type?: string; label?: string }) =>
    value?.type === "api" ? language.t("provider.connect.method.apiKey") : value?.label ?? ""

  const markConnected = () => {
    const current = provider()
    queryClient.setQueryData<NormalizedProviderListResponse | undefined>(
      queryOptions.providers(null).queryKey,
      (cached) => {
        const providerList = cached ?? providers.state()
        return {
          ...providerList,
          all: new Map(providerList.all).set(props.provider, { ...current, source: "api" }),
          connected: providerList.connected.includes(props.provider)
            ? providerList.connected
            : [...providerList.connected, props.provider],
        }
      },
    )
  }

  const complete = async () => {
    markConnected()
    await globalSDK.client.global.dispose().catch(() => undefined)
    dialog.close()
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("provider.connect.toast.connected.title", { provider: provider().name }),
      description: language.t("provider.connect.toast.connected.description", { provider: provider().name }),
    })
  }

  const fail = (err: unknown) => {
    setStore("state", "error")
    setStore("saving", false)
    setStore("error", err instanceof Error ? err.message : String(err))
  }

  async function finishOAuth(code?: string) {
    if (store.methodIndex === undefined) return
    setStore("saving", true)
    setStore("error", undefined)
    try {
      await globalSDK.client.provider.oauth.callback({
        providerID: props.provider,
        method: store.methodIndex,
        ...(code ? { code } : {}),
      }, { throwOnError: true })
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
        providerID: props.provider,
        method: index,
      }, { throwOnError: true })
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
          source: "managed",
          label: provider().name,
          secret: apiKey,
        }),
      })
      await complete()
    } catch (err) {
      setStore("error", err instanceof Error ? err.message : String(err))
    } finally {
      setStore("saving", false)
    }
  }

  return (
    <Dialog title={language.t("provider.connect.title", { provider: provider().name })} transition>
      <div class="flex flex-col gap-6">
        <div class="flex items-center gap-3">
          <ProviderIcon id={provider().id} class="size-5 shrink-0 icon-strong-base" />
          <span class="text-14-medium text-text-strong">{provider().name}</span>
        </div>
        <Switch>
          <Match when={selected()?.type === "api" || apiMethodIndex() === 0}>
            <form onSubmit={saveApiKey} class="flex flex-col items-start gap-4">
              <div class="text-14-regular text-text-base">
                {language.t("provider.connect.apiKey.description", { provider: provider().name })}
              </div>
              <TextField
                autofocus
                type="text"
                label={language.t("provider.connect.apiKey.label", { provider: provider().name })}
                placeholder={language.t("provider.connect.apiKey.placeholder")}
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
                {language.t("provider.connect.oauth.auto.visit.suffix", { provider: provider().name })}
              </div>
              <TextField
                label={language.t("provider.connect.oauth.auto.confirmationCode")}
                value={store.authorization!.instructions.replace(/^Enter code:\\s*/i, "")}
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
                void finishOAuth(store.code.trim())
              }}
            >
              <div class="text-14-regular text-text-base">
                {language.t("provider.connect.oauth.code.visit.prefix")}
                <Link href={store.authorization!.url}>{language.t("provider.connect.oauth.code.visit.link")}</Link>
                {language.t("provider.connect.oauth.code.visit.suffix", { provider: provider().name })}
              </div>
              <TextField
                autofocus
                type="text"
                label={language.t("provider.connect.oauth.code.label", { method: selected()?.label ?? "" })}
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
          <Match when={true}>
            <div class="text-14-regular text-text-base">
              {language.t("provider.connect.selectMethod", { provider: provider().name })}
            </div>
            <List
              items={methods}
              key={(item) => item?.label}
              onSelect={(item, index) => {
                if (!item) return
                if (item.type === "oauth") {
                  void startOAuth(index)
                  return
                }
                setStore("methodIndex", index)
              }}
            >
              {(item) => (
                <div class="w-full flex items-center gap-x-2">
                  <span>{methodLabel(item)}</span>
                </div>
              )}
            </List>
          </Match>
        </Switch>
      </div>
    </Dialog>
  )
}

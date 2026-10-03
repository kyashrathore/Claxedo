import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useQuery } from "@tanstack/solid-query"
import { connectSubject, connectVars, type ConnectContext } from "@/lib/harness-catalog"
import { toAppError, useServer, type ProviderAuthMethod, type ProviderAuthorization } from "@/server"
import { showToast } from "@/ui"
import { connectMethodOptions, type ConnectMethodOption } from "./connect-methods"
import { useAccountsText, type AccountsKey } from "./i18n"

export type ConnectFormInput = {
  readonly provider: string
  readonly harness: string
  readonly context: ConnectContext
  readonly credentialId?: string
  readonly onConnected?: () => void | Promise<void>
}

type ContextCopy = Readonly<Record<ConnectContext["kind"], AccountsKey>>

export const CONTEXT_COPY = {
  title: { harness: "provider.connect.title.harness", engine: "provider.connect.title.engine" },
  autoVisitSuffix: { harness: "provider.connect.oauth.auto.visit.suffix.harness", engine: "provider.connect.oauth.auto.visit.suffix.engine" },
  codeVisitSuffix: { harness: "provider.connect.oauth.code.visit.suffix.harness", engine: "provider.connect.oauth.code.visit.suffix.engine" },
  connected: { harness: "provider.connect.toast.connected.description.harness", engine: "provider.connect.toast.connected.description.engine" },
} as const satisfies Record<string, ContextCopy>

function useConnectMethods(input: ConnectFormInput) {
  const server = useServer()
  const codexBundle = () => input.harness === "pi" && input.provider === "openai-codex"
  const auth = useQuery(() => ({ ...server.queries.providerConnect.authMethods(input.harness), staleTime: 0 }))
  const methods = createMemo((): readonly ProviderAuthMethod[] => auth.data?.[input.provider] ?? [])
  return {
    loading: () => auth.isPending,
    error: () => (auth.error ? toAppError(auth.error).message : undefined),
    authProviderId: () => (codexBundle() ? "codex-app-server" : input.provider),
    options: createMemo(() => connectMethodOptions(input.provider, methods())),
  }
}

function createConnectState() {
  const [store, setStore] = createStore({
    methodIndex: undefined as number | undefined,
    authorization: undefined as ProviderAuthorization | undefined,
    state: undefined as "pending" | "auto" | "code" | "error" | undefined,
    value: "",
    label: "",
    code: "",
    error: undefined as string | undefined,
    saving: false,
  })
  const pickMethod = (index: number) =>
    setStore({ methodIndex: index < 0 ? undefined : index, authorization: undefined, state: undefined, error: undefined, value: "", code: "" })
  const fail = (error: unknown) => setStore({ state: "error", saving: false, error: toAppError(error).message })
  return { store, setStore, pickMethod, fail }
}

function useComplete(input: ConnectFormInput) {
  const t = useAccountsText()
  return async () => {
    const vars = connectVars(input.context)
    showToast({ title: t("provider.connect.toast.connected.title", vars), description: t(CONTEXT_COPY.connected[input.context.kind], vars) })
    await input.onConnected?.()
  }
}

function useOAuth(input: ConnectFormInput, methods: ReturnType<typeof useConnectMethods>, state: ReturnType<typeof createConnectState>) {
  const server = useServer()
  const complete = useComplete(input)
  const { store, setStore, fail } = state
  const finish = async (code?: string) => {
    if (store.methodIndex === undefined) return
    setStore({ saving: true, error: undefined })
    try {
      await server.providerConnect.callback(methods.authProviderId(), store.methodIndex, code)
      await complete()
    } catch (error) {
      fail(error)
    }
  }
  const start = async (index: number) => {
    setStore({ methodIndex: index, authorization: undefined, state: "pending", error: undefined, saving: true })
    try {
      const authorization = await server.providerConnect.authorize(methods.authProviderId(), index)
      if (!authorization) return void (await complete())
      setStore({ authorization, state: authorization.method, saving: authorization.method === "auto" })
      if (authorization.method === "auto") void finish()
    } catch (error) {
      fail(error)
    }
  }
  return { start, finish }
}

function useSaveKey(input: ConnectFormInput, state: ReturnType<typeof createConnectState>) {
  const server = useServer()
  const t = useAccountsText()
  const complete = useComplete(input)
  const { store, setStore } = state
  const write = (secret: string, label: string) => {
    if (input.credentialId) return server.providerConnect.reconnect(input.credentialId, secret)
    return server.providerConnect.saveKey({ providerId: input.provider, label, secret })
  }
  return async (event: SubmitEvent) => {
    event.preventDefault()
    const secret = store.value.trim()
    const label = store.label.trim()
    const missing = !secret ? t("provider.connect.apiKey.required") : !input.credentialId && !label ? t("provider.connect.label.required") : undefined
    if (missing) {
      setStore("error", missing)
      return
    }
    setStore({ saving: true, error: undefined })
    try {
      await write(secret, label)
      await complete()
    } catch (error) {
      setStore("error", toAppError(error).message)
    } finally {
      setStore("saving", false)
    }
  }
}

export function createProviderConnect(input: ConnectFormInput) {
  const t = useAccountsText()
  const methods = useConnectMethods(input)
  const state = createConnectState()
  const oauth = useOAuth(input, methods, state)
  const selected = createMemo((): ConnectMethodOption | undefined => {
    const list = methods.options()
    if (state.store.methodIndex !== undefined) return list.find((option) => option.index === state.store.methodIndex)
    return list.length === 1 ? list[0] : undefined
  })
  const vars = () => connectVars(input.context)
  return {
    ...state,
    options: methods.options,
    loadingMethods: methods.loading,
    methodsError: methods.error,
    selected,
    vars,
    subject: () => connectSubject(input.context),
    methodCopy: (option: ConnectMethodOption, part: "title" | "for" | "how") => t(option.spec.copy[part], vars()),
    pastes: () => selected()?.type === "api" || selected()?.type === "token",
    startOAuth: oauth.start,
    finishOAuth: oauth.finish,
    saveApiKey: useSaveKey(input, state),
  }
}

export type ProviderConnect = ReturnType<typeof createProviderConnect>

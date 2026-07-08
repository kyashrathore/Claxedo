import { createSimpleContext } from "@opencode-ai/ui/context"
import { batch, createEffect, createMemo, createSignal, onCleanup, startTransition, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { useQuery } from "@tanstack/solid-query"
import { useModels } from "@/context/models"
import { useProviders } from "@claxedo/hooks/use-providers"
import { usePlatform } from "@claxedo/context/platform"
import { Persist, persisted } from "@/utils/persist"
import {
  clearLocalSelectionHandoff,
  cloneLocalSelectionState,
  getLocalSelectionHandoff,
  localDraftSelectionHandoffID,
  localSelectionHandoffQueryKey,
  setLocalSelectionHandoff,
  type LocalSelectionState,
} from "@claxedo/shell/session/local-selection-handoff"
import {
  localSelectionStateFromSessionConfig,
  sessionConfigRawQueryKey,
  sessionConfigPatchFromLocalSelection,
  sessionConfigSelectionQueryKey,
  sessionConfigSelectionSyncQueryKey,
  shouldExposeDefaultLocalModelFallback,
} from "@claxedo/shell/session/session-config-selection"
import { decodeSessionConfig } from "@claxedo/session-client/harness/profile"
import { agentListQuery, configQuery } from "../shared/query/directory"
import { useWorkspaceQuery } from "../shell/workspace/use-workspace-query"
import { createAgentRuntimeClient } from "../runtime/agent-runtime-client"
import { queryClient } from "../shared/query/query-client"
import { useSDK } from "@claxedo/context/sdk"
import {
  cycleModelVariant,
  firstValidSelectionModel,
  firstConnectedModel,
  getConfiguredAgentVariant,
  resolveModelVariant,
  type ModelKey,
} from "@claxedo/session-client/composer/model-strategy"

type State = LocalSelectionState
type ModelSource = "selected" | "agent" | "fallback"

type Saved = {
  session: Record<string, State | undefined>
  dirty: Record<string, boolean | undefined>
}

const WORKSPACE_KEY = "__workspace__"

const migrate = (value: unknown) => {
  if (!value || typeof value !== "object") return { session: {}, dirty: {} }

  const item = value as {
    session?: Record<string, State | undefined>
    pick?: Record<string, State | undefined>
    dirty?: Record<string, boolean | undefined>
  }

  const dirty = item.dirty && typeof item.dirty === "object"
    ? Object.fromEntries(Object.entries(item.dirty).filter((entry): entry is [string, true] => entry[1] === true))
    : {}

  if (item.session && typeof item.session === "object") return { session: item.session, dirty }
  if (!item.pick || typeof item.pick !== "object") return { session: {}, dirty }

  return {
    session: Object.fromEntries(Object.entries(item.pick).filter(([key]) => key !== WORKSPACE_KEY)),
    dirty,
  }
}

const localContextInput = {
  name: "Local", gate: true,
  init: (input: { sessionId?: Accessor<string | undefined> } = {}) => {
    const sdk = useSDK()
    const providers = useProviders()
    const models = useModels()
    const platform = usePlatform()

    const id = createMemo(() => {
      const session = input.sessionId?.()
      if (session === "new") return
      return session
    })
    const [hydrationSession, setHydrationSession] = createSignal<string | undefined>()
    createEffect(() => {
      const session = id()
      setHydrationSession(undefined)
      if (!session) return
      const timer = setTimeout(
        () => {
          setHydrationSession(session)
        },
        50,
      )
      onCleanup(() => clearTimeout(timer))
    })
    const directoryConfigQuery = useQuery(() =>
      configQuery({
        baseUrl: sdk.url,
        directory: sdk.directory,
        workspace: sdk.workspace(sdk.directory),
        client: sdk.client,
      }),
    )

    const workspaceClientOptions = () => {
      const workspace = sdk.workspace(sdk.directory)
      if (!workspace) return {}
      return {
        workspaceId: workspace.workspaceId,
        ...(workspace.kind === "cloud" || workspace.kind === "user-hosted" ? { workspaceKind: workspace.kind } : {}),
      }
    }

    const fetchSessionConfig = async (session: string) =>
      await createAgentRuntimeClient({
        serverUrl: sdk.url,
        request: platform.fetch ?? fetch,
        opencodeClient: sdk.client,
        // Thread the resolved relay identity: with an fs-path
        // directory and no workspaceId the config restore fell
        // through to the central control plane (404) and silently
        // wiped the session's saved model selection.
        ...(workspaceClientOptions()),
      }).getSessionConfig({
        directory: sdk.directory,
        sessionID: session,
      }).catch(() => null)

    const sessionConfigRawQuery = useQuery(() => {
      const session = hydrationSession()
      return {
        queryKey: sessionConfigRawQueryKey(session ?? "__claxedo_no_session__"),
        enabled: !!session,
        staleTime: 30 * 1000,
        queryFn: async () => session ? await fetchSessionConfig(session) : null,
      }
    })

    const currentSessionHarnessId = createMemo(() => decodeSessionConfig(sessionConfigRawQuery.data).harness?.type)
    const harnessType = () => {
      const type = currentSessionHarnessId()
      return type === "opencode" ? undefined : type
    }

    // agentListQuery routes to the workspace runtime for relay-backed scopes —
    // gate on the authority so it cannot fire while that workspace is offline.
    // Local scopes (`workspace()` undefined) are a no-op gate (always ready).
    const directoryAgentsQuery = useWorkspaceQuery(() => ({
      ...agentListQuery({
        baseUrl: sdk.url,
        directory: sdk.directory,
        harnessType: harnessType(),
        request: platform.fetch ?? fetch,
        workspace: sdk.workspace(sdk.directory),
        client: sdk.client,
      }),
      workspaceId: sdk.workspace(sdk.directory)?.workspaceId,
    }))
    const list = createMemo(() => (directoryAgentsQuery.data ?? []).filter((item) => item.mode !== "subagent" && !item.hidden))
    const connected = createMemo(() => new Set(providers.connected().map((item) => item.id)))

    const [saved, setSaved] = persisted(
      {
        ...Persist.workspace(sdk.directory, "model-selection", ["model-selection.v1"]),
        migrate,
      },
      createStore<Saved>({
        session: {},
        dirty: {},
      }),
    )

    const [store, setStore] = createStore<{
      current?: string
      draft?: State
      last?: {
        type: "agent" | "model" | "variant"
        agent?: string
        model?: ModelKey | null
        variant?: string | null
      }
    }>({
      current: list()[0]?.name,
      draft: undefined,
      last: undefined,
    })

    const selectionHandoffID = () => id() ?? localDraftSelectionHandoffID(sdk.directory)
    const selectionHandoffQuery = useQuery(() => ({
      queryKey: localSelectionHandoffQueryKey(selectionHandoffID()),
      queryFn: async (): Promise<State | undefined> => undefined,
      enabled: false,
    }))
    const sessionConfigSelectionQuery = useQuery(() => {
      const session = hydrationSession()
      return {
        queryKey: sessionConfigSelectionQueryKey(session ?? "__claxedo_no_session__"),
        enabled: !!session,
        staleTime: 30 * 1000,
        queryFn: async (): Promise<State | null> => {
          if (!session) return null
          return localSelectionStateFromSessionConfig(
            await queryClient.fetchQuery({
              queryKey: sessionConfigRawQueryKey(session),
              staleTime: 30 * 1000,
              queryFn: async () => await fetchSessionConfig(session),
            }),
          ) ?? null
        },
      }
    })

    const validModel = (model: ModelKey) => {
      const provider = providers.all().get(model.providerID)
      return !!provider?.models[model.modelID] && connected().has(model.providerID)
    }

    const firstModel = (...items: Array<() => ModelKey | undefined>) => {
      for (const item of items) {
        const model = item()
        if (!model) continue
        if (validModel(model)) return model
      }
    }

    const pickAgent = (name: string | undefined) => {
      const items = list()
      if (items.length === 0) return
      return items.find((item) => item.name === name) ?? items[0]
    }

    createEffect(() => {
      const items = list()
      if (items.length === 0) {
        if (store.current !== undefined) setStore("current", undefined)
        return
      }
      if (items.some((item) => item.name === store.current)) return
      setStore("current", items[0]?.name)
    })

    const isOpenCodeSessionScope = (session: string) => {
      if (hydrationSession() !== session) return false
      const type = currentSessionHarnessId()
      if (type && type !== "opencode") return false
      if (sessionConfigRawQuery.isLoading || sessionConfigRawQuery.isFetching) return false
      return true
    }

    const sameState = (left: State | undefined, right: State | undefined) =>
      JSON.stringify(cloneLocalSelectionState(left)) === JSON.stringify(cloneLocalSelectionState(right))

    const sessionConfigSelectionLoading = createMemo(() => {
      const session = id()
      if (!session) return false
      if (hydrationSession() !== session) return true
      return sessionConfigSelectionQuery.isLoading || sessionConfigSelectionQuery.isFetching
    })

    const syncSessionSelection = (session: string, state: State) => {
      if (!isOpenCodeSessionScope(session)) return
      const key = sessionConfigSelectionSyncQueryKey(session)
      const pending = queryClient.getQueryData<Promise<void>>(key)
      if (pending) return

      const run = createAgentRuntimeClient({
        serverUrl: sdk.url,
        request: platform.fetch ?? fetch,
        opencodeClient: sdk.client,
        ...(workspaceClientOptions()),
      }).updateSessionConfig({
        directory: sdk.directory,
        sessionID: session,
        patch: sessionConfigPatchFromLocalSelection(state),
      })
        .then(() => {
          queryClient.setQueryData(sessionConfigSelectionQueryKey(session), cloneLocalSelectionState(state))
          if (sameState(saved.session[session], state)) setSaved("dirty", session, false)
        })
        .catch(() => {})
        .finally(() => {
          if (queryClient.getQueryData(sessionConfigSelectionSyncQueryKey(session)) === run) {
            queryClient.removeQueries({ queryKey: sessionConfigSelectionSyncQueryKey(session), exact: true })
          }
        })

      queryClient.setQueryData(key, run)
    }

    const commitSessionState = (session: string, state: State) => {
      setSaved("session", session, state)
      if (!isOpenCodeSessionScope(session)) return
      setSaved("dirty", session, true)
      syncSessionSelection(session, state)
    }

    createEffect(() => {
      const session = id()
      if (!session) return
      if (!saved.dirty[session]) return
      const state = saved.session[session]
      if (!state) return
      syncSessionSelection(session, state)
    })

    const scope = createMemo<State | undefined>(() => {
      const session = id()
      const sessionConfigSelection = sessionConfigSelectionQuery.data ?? undefined
      if (!session) return store.draft ?? selectionHandoffQuery.data
      if (saved.dirty[session] && saved.session[session]) return saved.session[session]
      if (store.last === undefined) {
        if (sessionConfigSelectionQuery.data !== undefined) return sessionConfigSelection
        if (sessionConfigSelectionLoading()) return
      }
      return saved.session[session] ?? selectionHandoffQuery.data ?? sessionConfigSelection
    })

    const restorePending = () => {
      const session = id()
      if (!session) return false
      if (saved.dirty[session] && saved.session[session]) return false
      if (store.last !== undefined && saved.session[session] !== undefined) return false
      if (selectionHandoffQuery.data) return false
      if (sessionConfigSelectionQuery.data) return false
      return sessionConfigSelectionLoading()
    }

    createEffect(() => {
      const session = id()
      if (!session) return

      const next = selectionHandoffQuery.data
      if (!next) return
      if (saved.session[session] !== undefined) {
        clearLocalSelectionHandoff(session)
        return
      }

      setSaved("session", session, cloneLocalSelectionState(next))
      clearLocalSelectionHandoff(session)
    })

    const configuredModel = () => {
      const configured = directoryConfigQuery.data?.model
      if (!configured) return
      const [providerID, modelID] = configured.split("/")
      const model = { providerID, modelID }
      if (validModel(model)) return model
    }

    const recentModel = () => {
      for (const item of models.recent.list()) {
        if (validModel(item)) return item
      }
    }

    const savedModel = () =>
      firstValidSelectionModel({
        selections: Object.values(saved.session).reverse(),
        valid: validModel,
      })

    const defaultModel = () => firstConnectedModel({
      connected: providers.connected(),
      defaults: providers.default(),
    })

    const fallback = createMemo<ModelKey | undefined>(() => savedModel() ?? recentModel() ?? configuredModel() ?? defaultModel())

    const agent = {
      list,
      current() {
        return pickAgent(scope()?.agent ?? store.current)
      },
      set(name: string | undefined) {
        const item = pickAgent(name)
        if (!item) {
          setStore("current", undefined)
          return
        }

        batch(() => {
          setStore("current", item.name)
          setStore("last", {
            type: "agent",
            agent: item.name,
            model: item.model,
            variant: item.variant ?? null,
          })
          const prev = scope()
          const next = {
            agent: item.name,
            model: item.model ?? prev?.model,
            variant: item.variant ?? prev?.variant,
          } satisfies State
          const session = id()
          if (session) {
            commitSessionState(session, next)
            return
          }
          setStore("draft", next)
        })
      },
      move(direction: 1 | -1) {
        const items = list()
        if (items.length === 0) {
          setStore("current", undefined)
          return
        }

        let next = items.findIndex((item) => item.name === agent.current()?.name) + direction
        if (next < 0) next = items.length - 1
        if (next >= items.length) next = 0
        const item = items[next]
        if (!item) return
        agent.set(item.name)
      },
    }

    const currentModelKey = (): { source: ModelSource; model: ModelKey } | undefined => {
      const selectedState = scope()
      const selected = firstModel(() => selectedState?.model)
      if (selected) return { source: "selected", model: selected }

      const agentModel = selectedState?.agent ? firstModel(() => agent.current()?.model) : undefined
      if (agentModel) return { source: "agent", model: agentModel }

      if (!shouldExposeDefaultLocalModelFallback({
        existingSession: !!id(),
        hasSelection: !!selectedState?.model,
        hasValidSelection: !!selected,
        restoreLoading: restorePending(),
      })) return

      const fallbackModel = firstModel(fallback)
      if (fallbackModel) return { source: "fallback", model: fallbackModel }
    }

    const current = () => {
      const item = currentModelKey()
      if (!item) return
      return models.find(item.model)
    }

    const configured = () => {
      const item = agent.current()
      const model = current()
      if (!item || !model) return
      return getConfiguredAgentVariant({
        agent: { model: item.model, variant: item.variant },
        model: { providerID: model.provider.id, modelID: model.id, variants: model.variants },
      })
    }

    const selected = () => scope()?.variant

    const snapshot = () => {
      const model = current()
      return {
        agent: agent.current()?.name,
        model: model ? { providerID: model.provider.id, modelID: model.id } : undefined,
        variant: selected(),
      } satisfies State
    }

    const write = (next: Partial<State>) => {
      const state = {
        ...(scope() ?? { agent: agent.current()?.name }),
        ...next,
      } satisfies State

      const session = id()
      if (session) {
        commitSessionState(session, state)
        return
      }
      setStore("draft", state)
    }

    const recent = createMemo(() => models.recent.list().map(models.find).filter(Boolean))

    const model = {
      ready: models.ready,
      restorePending,
      currentSource() {
        return currentModelKey()?.source
      },
      selected() {
        return scope()?.model
      },
      current,
      recent,
      list: models.list,
      cycle(direction: 1 | -1) {
        const items = recent()
        const item = current()
        if (!item) return

        const index = items.findIndex((entry) => entry?.provider.id === item.provider.id && entry?.id === item.id)
        if (index === -1) return

        let next = index + direction
        if (next < 0) next = items.length - 1
        if (next >= items.length) next = 0

        const entry = items[next]
        if (!entry) return
        model.set({ providerID: entry.provider.id, modelID: entry.id })
      },
      set(item: ModelKey | undefined, options?: { recent?: boolean }) {
        startTransition(() =>
          batch(() => {
            setStore("last", {
              type: "model",
              agent: agent.current()?.name,
              model: item ?? null,
              variant: selected(),
            })
            write({ model: item })
            if (!item) return
            models.setVisibility(item, true)
            if (!options?.recent) return
            models.recent.push(item)
          }),
        )
      },
      visible(item: ModelKey) {
        return models.visible(item)
      },
      setVisibility(item: ModelKey, visible: boolean) {
        models.setVisibility(item, visible)
      },
      variant: {
        configured,
        selected,
        current() {
          const resolved = resolveModelVariant({
            variants: this.list(),
            selected: this.selected(),
            configured: this.configured(),
          })
          if (resolved) return resolved
          const model = current()
          if (!model) return
          const saved = models.variant.get({ providerID: model.provider.id, modelID: model.id })
          if (saved && this.list().includes(saved)) return saved
        },
        list() {
          const item = current()
          if (!item?.variants) return []
          return Object.keys(item.variants)
        },
        set(value: string | undefined) {
          batch(() => {
            const model = current()
            setStore("last", {
              type: "variant",
              agent: agent.current()?.name,
              model: model ? { providerID: model.provider.id, modelID: model.id } : null,
              variant: value ?? null,
            })
            write({ variant: value ?? null })
            if (model) {
              models.variant.set({ providerID: model.provider.id, modelID: model.id }, value ?? undefined)
            }
          })
        },
        cycle() {
          const items = this.list()
          if (items.length === 0) return
          this.set(
            cycleModelVariant({
              variants: items,
              selected: this.selected(),
              configured: this.configured(),
            }),
          )
        },
      },
    }

    const result = {
      model,
      agent,
      session: {
        reset() {
          setStore("draft", undefined)
          clearLocalSelectionHandoff(localDraftSelectionHandoffID(sdk.directory))
        },
        promote(dir: string, session: string, state?: State) {
          const next = cloneLocalSelectionState(state ?? snapshot())
          if (!next) return

          clearLocalSelectionHandoff(localDraftSelectionHandoffID(sdk.directory))
          if (dir === sdk.directory) {
            commitSessionState(session, next)
            setStore("draft", undefined)
            return
          }

          setLocalSelectionHandoff(session, next)
          setStore("draft", undefined)
        },
        restore(msg: { sessionID: string; agent: string; model: ModelKey }) {
          const session = id()
          if (!session) return
          if (msg.sessionID !== session) return
          const current = saved.session[session]
          if (current?.agent && current.model) return
          if (getLocalSelectionHandoff(session)) return

          setSaved("session", session, {
            ...current,
            agent: msg.agent,
            model: msg.model,
            variant: msg.model?.variant ?? null,
          })
        },
      },
    }
    return result
  },
}
export const { use: useLocal, provider: LocalProvider } = createSimpleContext<ReturnType<typeof localContextInput.init>, { sessionId?: Accessor<string | undefined> }>(localContextInput)

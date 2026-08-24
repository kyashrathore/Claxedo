import { createSimpleContext } from "@opencode-ai/ui/context"
import { batch, createEffect, createMemo, createSignal, onCleanup, startTransition, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { useQuery } from "@tanstack/solid-query"
import { settledQueryData } from "@/platform/query/settled-query-data"
import { useModels } from "@/features/session/providers/models"
import { useProviders } from "@/features/session/app-ports"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { fastSessionSwitchAnyQuietDelay } from "@/platform/runtime/session-switch"
import { Persist, persisted } from "@/platform/persistence/persist"
import {
  clearLocalSelectionHandoff,
  cloneLocalSelectionState,
  getLocalSelectionHandoff,
  localDraftSelectionHandoffID,
  localSelectionHandoffQueryKey,
  setLocalSelectionHandoff,
  type LocalSelectionState,
} from "@/features/session/store/local-selection-handoff"
import {
  localSelectionStateFromSessionConfig,
  sessionConfigRawQueryKey,
  sessionConfigPatchFromLocalSelection,
  sessionConfigSelectionQueryKey,
  shouldExposeDefaultLocalModelFallback,
} from "@/features/session/store/session-config-selection"
import { createSessionSyncRetry } from "./session-config-sync-retry"
import { decodeSessionConfig } from "@/features/session/harness/profile"
import { agentListQuery, configQuery, type Agent } from "../data/query/directory"
import { useWorkspaceQuery } from "@/features/session/app-ports"
import { createAgentRuntimeClient } from "@/platform/runtime/agent/agent-runtime-client"
import type { SessionRef } from "@/platform/identity/session-ref"
import { queryClient } from "@/platform/query/query-client"
import { useSDK } from "@/features/session/app-ports"
import { createDeferredDirectoryResourceGate } from "../data/query/deferred-directory-resource"
import {
  cycleModelVariant,
  firstValidSelectionModel,
  firstConnectedModel,
  getConfiguredAgentVariant,
  resolveModelVariant,
  selectionProviderDetailNeeded,
  type ModelKey,
} from "@/features/session/composer/model-strategy"

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
  init: (input: {
    sessionId?: Accessor<string | undefined>
    sessionRef?: Accessor<SessionRef | undefined>
    active?: Accessor<boolean>
    agents?: Accessor<Agent[]>
  } = {}) => {
    const sdk = useSDK()
    const providers = useProviders()
    const models = useModels()
    const platform = usePlatform()

    const id = createMemo(() => {
      const session = input.sessionId?.()
      if (session === "new") return
      return session
    })
    const hydrationReady = createDeferredDirectoryResourceGate({
      scope: id,
      active: input.active,
      delayMs: () => fastSessionSwitchAnyQuietDelay({ baseDelay: 250 }),
      afterPaint: false,
    })
    const hydrationSession = () => hydrationReady() ? id() : undefined
    const hydrateDirectoryConfig = createDeferredDirectoryResourceGate({
      scope: () => `${sdk.url ?? ""}:${sdk.directory}:config`,
      active: input.active,
    })
    const directoryConfigQuery = useQuery(() => ({
      ...configQuery({
        baseUrl: sdk.url,
        directory: sdk.directory,
        workspace: sdk.workspace(sdk.directory),
        client: sdk.client,
      }),
      enabled: hydrateDirectoryConfig(),
    }))

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
        sessionRef: input.sessionRef?.(),
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

    const currentSessionHarnessId = createMemo(() => decodeSessionConfig(settledQueryData(sessionConfigRawQuery)).harness?.type)
    const harnessType = () => {
      const type = currentSessionHarnessId()
      return type === "opencode" ? undefined : type
    }

    // agentListQuery routes to the workspace runtime for relay-backed scopes —
    // gate on the authority so it cannot fire while that workspace is offline.
    // Local scopes (`workspace()` undefined) are a no-op gate (always ready).
    const hydrateDirectoryAgents = createDeferredDirectoryResourceGate({
      scope: () => `${sdk.url ?? ""}:${sdk.directory}:${harnessType() ?? ""}:agents`,
      active: input.active,
    })
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
      enabled: !input.agents && hydrateDirectoryAgents(),
    }))
    const list = createMemo(() => (input.agents?.() ?? settledQueryData(directoryAgentsQuery) ?? [])
      .filter((item) => item.mode !== "subagent" && !item.hidden))
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

    // Deliberate, bounded retry for the config-selection PATCH. Replaces the old accidental
    // retry that re-fired the same doomed PATCH on every `sessionConfigRawQuery.isFetching`
    // toggle during hydration. On failure we retry on an explicit backoff timer up to
    // `maxAttempts`; after that the cycle stops but the persisted `dirty` flag is kept, so the
    // write is never silently dropped — it flushes again on the next mount, or is re-armed by an
    // explicit user selection (`deliberate: true`).
    const syncRetry = createSessionSyncRetry({
      maxAttempts: 5,
      backoffMs: (failed) => Math.min(30_000, 500 * 2 ** (failed - 1)),
      scopeReady: (session) => isOpenCodeSessionScope(session),
      sameState,
      patch: (session, state) =>
        createAgentRuntimeClient({
          serverUrl: sdk.url,
          request: platform.fetch ?? fetch,
          opencodeClient: sdk.client,
          sessionRef: input.sessionRef?.(),
          ...(workspaceClientOptions()),
        }).updateSessionConfig({
          directory: sdk.directory,
          sessionID: session,
          patch: sessionConfigPatchFromLocalSelection(state),
        }),
      onSuccess: (session, state) => {
        queryClient.setQueryData(sessionConfigSelectionQueryKey(session), cloneLocalSelectionState(state))
        if (sameState(saved.session[session], state)) setSaved("dirty", session, false)
      },
      // onExhausted intentionally omitted: the persisted `dirty` flag stays set so a permanently
      // failed write surfaces on the next hydration rather than being silently discarded.
      schedule: (fn, ms) => {
        const timer = setTimeout(fn, ms)
        return { cancel: () => clearTimeout(timer) }
      },
    })
    onCleanup(() => syncRetry.dispose())

    const commitSessionState = (session: string, state: State) => {
      setSaved("session", session, state)
      if (!isOpenCodeSessionScope(session)) return
      setSaved("dirty", session, true)
      // Explicit user selection: reset the retry ledger and fire a fresh attempt.
      syncRetry.arm(session, state, { deliberate: true })
    }

    createEffect(() => {
      const session = id()
      if (!session) return
      if (!saved.dirty[session]) return
      const state = saved.session[session]
      if (!state) return
      // Hydration flush: `arm` reads `scopeReady` (which tracks `sessionConfigRawQuery.isFetching`),
      // so this effect still re-runs on hydration churn — but `arm` now only advances an
      // already-armed idle attempt and never re-fires a failed or exhausted PATCH.
      syncRetry.arm(session, state, { deliberate: false })
    })

    const scope = createMemo<State | undefined>(() => {
      const session = id()
      const sessionConfigSelection = settledQueryData(sessionConfigSelectionQuery) ?? undefined
      if (!session) return store.draft ?? settledQueryData(selectionHandoffQuery)
      if (saved.dirty[session] && saved.session[session]) return saved.session[session]
      if (store.last === undefined) {
        if (settledQueryData(sessionConfigSelectionQuery) !== undefined) return sessionConfigSelection
        if (sessionConfigSelectionLoading()) return
      }
      return saved.session[session] ?? settledQueryData(selectionHandoffQuery) ?? sessionConfigSelection
    })

    const restorePending = () => {
      const session = id()
      if (!session) return false
      if (saved.dirty[session] && saved.session[session]) return false
      if (store.last !== undefined && saved.session[session] !== undefined) return false
      if (settledQueryData(selectionHandoffQuery)) return false
      if (settledQueryData(sessionConfigSelectionQuery)) return false
      return sessionConfigSelectionLoading()
    }

    createEffect(() => {
      const session = id()
      if (!session) return

      const next = settledQueryData(selectionHandoffQuery)
      if (!next) return
      if (saved.session[session] !== undefined) {
        clearLocalSelectionHandoff(session)
        return
      }

      setSaved("session", session, cloneLocalSelectionState(next))
      clearLocalSelectionHandoff(session)
    })

    const configuredModel = () => {
      const configured = settledQueryData(directoryConfigQuery)?.model
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

    // Heal an index-shaped catalog under a saved selection. Boot fetches the
    // provider INDEX (one default model per connected provider), so a restored
    // NON-default selection fails `validModel` — and without this the composer
    // silently fell back to the provider default until the user happened to
    // open Manage models. Loading the one provider's detail is idempotent
    // (`providers.load` single-flights and caches per provider), so this
    // settles after at most one small request per selected provider.
    createEffect(() => {
      const providerId = selectionProviderDetailNeeded({
        model: scope()?.model,
        connected: connected(),
        provider: providers.all().get(scope()?.model?.providerID ?? ""),
      })
      if (!providerId) return
      void providers.load(providerId).catch(() => undefined)
    })

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
      hydrate: models.hydrate,
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
            // The create request already persisted this exact state atomically.
            // Install it locally without scheduling a redundant config PATCH.
            setSaved("session", session, next)
            setSaved("dirty", session, false)
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
export const { use: useLocal, provider: LocalProvider } = createSimpleContext<
  ReturnType<typeof localContextInput.init>,
  {
    sessionId?: Accessor<string | undefined>
    sessionRef?: Accessor<SessionRef | undefined>
    active?: Accessor<boolean>
    agents?: Accessor<Agent[]>
  }
>(localContextInput)

import { createSimpleContext } from "@opencode-ai/ui/context"
import { batch, createEffect, createMemo, startTransition, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { queryOptions, skipToken, useQuery } from "@tanstack/solid-query"
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
  sessionConfigSelectionQueryKey,
} from "@/features/session/store/session-config-selection"
import { decodeSessionConfig } from "@/features/session/harness/profile"
import { agentListQuery, type Agent } from "../data/query/directory"
import { useWorkspaceQuery } from "@/features/session/app-ports"
import { createAgentRuntimeClient, type AgentRuntimeDirectory } from "@/platform/runtime/agent/agent-runtime-client"
import type { SessionRef } from "@/platform/identity/session-ref"
import { queryClient } from "@/platform/query/query-client"
import { useSDK } from "@/features/session/app-ports"
import { createDeferredDirectoryResourceGate } from "../data/query/deferred-directory-resource"
import { harnessSelectionValue } from "@/platform/identity/harness-selection"
import { parkedPaneQueryOptions, type PaneQueryOptions } from "../store/pane-query-observer"
import {
  cycleModelVariant,
  getConfiguredAgentVariant,
  resolveModelVariant,
  selectionProviderDetailNeeded,
  type ModelKey,
} from "@/features/session/composer/model-strategy"
import { isRelayBackedWorkspaceKind } from "@/platform/runtime/agent/workspace-kind"

type State = LocalSelectionState
type ModelSource = "selected" | "agent"

type Saved = {
  session: Record<string, State | undefined>
}

const SESSION_CONFIG_STALE_TIME = 30 * 1000

type SessionConfigRequest = {
  runtime: NonNullable<Parameters<typeof createAgentRuntimeClient>[0]>
  directory: AgentRuntimeDirectory
  sessionID: string
}

function sessionConfigQueryScope(input: SessionConfigRequest) {
  return {
    sessionID: input.sessionID,
    directory: input.directory,
    workspaceId: input.runtime.workspaceId,
    sessionRef: input.runtime.sessionRef,
    serverUrl: input.runtime.serverUrl,
  }
}

async function loadSessionConfig(input: SessionConfigRequest, signal?: AbortSignal) {
  return await createAgentRuntimeClient(input.runtime)
    .getSessionConfig({ directory: input.directory, sessionID: input.sessionID, signal })
    .catch((error) => {
      if (signal?.aborted) throw error
      return null
    })
}

// The runtime's `/config` payload is an unparsed JSON boundary: `decodeSessionConfig`
// and `localSelectionStateFromSessionConfig` are the parsers, so `unknown` is the
// honest query data type. Stating the return type collapses the parked and live
// arms into one shape for `useQuery`/`fetchQuery`.
function sessionConfigRawOptions(input: SessionConfigRequest | undefined): PaneQueryOptions<unknown> {
  if (!input) return {
    ...parkedPaneQueryOptions<unknown>("session-config-raw", "no-session"),
    staleTime: SESSION_CONFIG_STALE_TIME,
  }
  return {
    queryKey: sessionConfigRawQueryKey(sessionConfigQueryScope(input)),
    enabled: true,
    staleTime: SESSION_CONFIG_STALE_TIME,
    queryFn: async ({ signal }) => await loadSessionConfig(input, signal),
  }
}

function sessionConfigSelectionOptions(input: SessionConfigRequest | undefined) {
  if (!input) return {
    ...parkedPaneQueryOptions<State | null>("session-config-selection", "no-session"),
    staleTime: SESSION_CONFIG_STALE_TIME,
  }
  return queryOptions<State | null>({
    queryKey: sessionConfigSelectionQueryKey(sessionConfigQueryScope(input)),
    enabled: true,
    staleTime: SESSION_CONFIG_STALE_TIME,
    queryFn: async (): Promise<State | null> => localSelectionStateFromSessionConfig(
      await queryClient.fetchQuery(sessionConfigRawOptions(input)),
    ) ?? null,
  })
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
    const models = useModels()
    const platform = usePlatform()

    const id = createMemo(() => {
      const session = input.sessionId?.()
      if (session === "new") return undefined
      return session
    })
    const hydrationReady = createDeferredDirectoryResourceGate({
      scope: id,
      active: input.active,
      delayMs: () => fastSessionSwitchAnyQuietDelay({ baseDelay: 250 }),
      afterPaint: false,
    })
    const hydrationSession = () => hydrationReady() ? id() : undefined
    const workspaceClientOptions = () => {
      const workspace = sdk.workspace(sdk.directory)
      if (!workspace) return {}
      return {
        workspaceId: workspace.workspaceId,
        ...(isRelayBackedWorkspaceKind(workspace.kind) ? { workspaceKind: workspace.kind } : {}),
      }
    }

    const sessionConfigRequest = (session: string | undefined): SessionConfigRequest | undefined => {
      if (!session) return undefined
      return {
        runtime: {
          serverUrl: sdk.url,
          request: platform.fetch ?? fetch,
          sessionRef: input.sessionRef?.(),
          // Thread the resolved relay identity: with an fs-path
          // directory and no workspaceId the config restore fell
          // through to the central control plane (404) and silently
          // wiped the session's saved model selection.
          ...(workspaceClientOptions()),
        },
        directory: sdk.directory,
        sessionID: session,
      }
    }

    const sessionConfigRawQuery = useQuery(() => sessionConfigRawOptions(
      sessionConfigRequest(hydrationSession()),
    ))

    const currentSessionHarnessId = createMemo(() => decodeSessionConfig(settledQueryData(sessionConfigRawQuery)).harness?.type)
    // The session's own harness, including "opencode": the agent-profile and
    // catalog reads key on it, and an UNRESOLVED harness is unknown — never
    // OpenCode by omission.
    const harnessType = () => { const selection = currentSessionHarnessId(); return selection ? harnessSelectionValue(selection) : undefined }
    const providers = useProviders(() => currentSessionHarnessId()?.kind === "native" ? harnessType() ?? "" : "")

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
      }),
      workspaceId: sdk.workspace(sdk.directory)?.workspaceId,
      enabled: !input.agents && hydrateDirectoryAgents(),
    }))
    const catalog = createMemo(() => input.agents?.() ?? settledQueryData(directoryAgentsQuery) ?? [])
    const list = createMemo(() => catalog().filter((item) => item.mode !== "subagent" && !item.hidden))
    const connected = createMemo(() => new Set(providers.connected().map((item) => item.id)))

    const [saved, setSaved] = persisted(
      Persist.workspace(sdk.directory, "model-selection"),
      createStore<Saved>({
        session: {},
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
    const selectionHandoffQuery = useQuery<State | undefined>(() => ({
      queryKey: localSelectionHandoffQueryKey(selectionHandoffID()),
      queryFn: skipToken,
      enabled: false,
    }))
    const sessionConfigSelectionQuery = useQuery(() => sessionConfigSelectionOptions(
      sessionConfigRequest(hydrationSession()),
    ))

    const validModel = (model: ModelKey) => {
      const provider = providers.all().get(model.providerID)
      return !!provider?.models[model.modelID] && connected().has(model.providerID)
    }

    const isUsableSelection = (model: ModelKey | undefined): model is ModelKey => !!model

    const selectionCatalogPending = (model: ModelKey | undefined) => {
      if (!isUsableSelection(model)) return false
      if (validModel(model) || models.find(model)) return false
      return selectionProviderDetailNeeded({
        model,
        connected: connected(),
        provider: providers.all().get(model.providerID),
      }) !== undefined
    }

    const resolveExplicitSelection = (selectedState: State | undefined): ModelKey | undefined => {
      const raw = selectedState?.model
      if (!isUsableSelection(raw)) return undefined
      if (validModel(raw)) return raw
      if (models.find(raw)) return raw
      if (selectionCatalogPending(raw)) return raw
      return undefined
    }

    const materializeModel = (model: ModelKey) => {
      const hit = models.find(model)
      if (hit) return hit
      const provider = providers.all().get(model.providerID)
      const indexed = provider?.models[model.modelID]
      if (!indexed || !connected().has(model.providerID)) return undefined
      return {
        ...indexed,
        name: indexed.name.replace("(latest)", "").trim(),
        latest: indexed.name.includes("(latest)"),
        provider,
      }
    }

    const firstModel = (...items: Array<() => ModelKey | undefined>) => {
      for (const item of items) {
        const model = item()
        if (!model) continue
        if (validModel(model)) return model
      }
      return undefined
    }

    const pickAgent = (name: string | undefined) => {
      const items = list()
      if (items.length === 0) return undefined
      return items.find((item) => item.id === name || item.name === name) ?? items[0]
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

    const sessionConfigSelectionLoading = createMemo(() => {
      const session = id()
      if (!session) return false
      if (hydrationSession() !== session) return true
      return sessionConfigSelectionQuery.isLoading || sessionConfigSelectionQuery.isFetching
    })

    const commitSessionState = (session: string, state: State) => {
      setSaved("session", session, state)
    }

    const scope = createMemo<State | undefined>(() => {
      const session = id()
      const selectionHandoff = settledQueryData(selectionHandoffQuery)
      const sessionConfigSelection = settledQueryData(sessionConfigSelectionQuery) ?? undefined
      if (!session) return store.draft ?? selectionHandoff
      if (store.last === undefined) {
        // Session creation publishes the exact config atomically. A remounted
        // workbench owner must consume that handoff before the deferred config
        // read's loading gate, otherwise it briefly renders an unconfigured
        // composer and turns the first follow-up click into "Choose a model".
        // Once this owner records a local selection, its saved state supersedes
        // the one-shot handoff even if the disabled query mirror still exposes
        // its last settled value after the cache entry has been consumed.
        if (selectionHandoff) return selectionHandoff
        if (settledQueryData(sessionConfigSelectionQuery) !== undefined) return sessionConfigSelection
        if (sessionConfigSelectionLoading()) return undefined
      }
      return saved.session[session] ?? sessionConfigSelection
    })

    const restorePending = () => {
      const session = id()
      if (!session) return false
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
      // `list` drops pure subagents because they cannot be the session's own
      // agent; the @-mention popover still needs them as delegation targets.
      catalog,
      current: () => {
        return pickAgent(scope()?.agent ?? store.current)
      },
      set: (name: string | undefined) => {
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
            // The scope value doubles as the prompt's `agent` field, which the
            // engine resolves by agent id — the display `name` is not it.
            agent: item.id ?? item.name,
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
      move: (direction: 1 | -1) => {
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
      const selected = resolveExplicitSelection(selectedState)
      if (selected) return { source: "selected", model: selected }

      const agentModel = selectedState?.agent ? firstModel(() => agent.current()?.model) : undefined
      if (agentModel) return { source: "agent", model: agentModel }
      return undefined
    }

    const current = () => {
      const item = currentModelKey()
      if (!item) return undefined
      return materializeModel(item.model)
    }

    const configured = () => {
      const item = agent.current()
      const model = current()
      if (!item || !model) return undefined
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

    const variant = {
      configured,
      selected,
      current: () => {
        const resolved = resolveModelVariant({
          variants: variant.list(),
          selected: variant.selected(),
          configured: variant.configured(),
        })
        if (resolved) return resolved
        const model = current()
        if (!model) return undefined
        const saved = models.variant.get({ providerID: model.provider.id, modelID: model.id })
        if (saved && variant.list().includes(saved)) return saved
        return undefined
      },
      list: () => {
        const item = current()
        if (!item?.variants) return []
        return Object.keys(item.variants)
      },
      set: (value: string | undefined) => {
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
      cycle: () => {
        const items = variant.list()
        if (items.length === 0) return
        variant.set(
          cycleModelVariant({
            variants: items,
            selected: variant.selected(),
            configured: variant.configured(),
          }),
        )
      },
    }

    const model = {
      ready: models.ready,
      restorePending,
      currentSource: () => {
        return currentModelKey()?.source
      },
      selected: () => {
        return scope()?.model
      },
      selectionCatalogPending: () => {
        return selectionCatalogPending(scope()?.model)
      },
      current,
      recent,
      list: models.list,
      hydrate: models.hydrate,
      cycle: (direction: 1 | -1) => {
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
      set: (item: ModelKey | undefined, options?: { recent?: boolean }) => {
        // Fire-and-forget: the returned promise only reports when the transition
        // settles, and the callback below is synchronous, so there is nothing to
        // await and no rejection path of ours.
        void startTransition(() =>
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
      visible: (item: ModelKey, defaults?: Record<string, string>) => {
        return models.visible(item, defaults)
      },
      setVisibility: (item: ModelKey, visible: boolean) => {
        models.setVisibility(item, visible)
      },
      variant,
    }

    const result = {
      model,
      agent,
      session: {
        reset: () => {
          setStore("draft", undefined)
          clearLocalSelectionHandoff(localDraftSelectionHandoffID(sdk.directory))
        },
        promote: (dir: string, session: string, state?: State) => {
          const next = cloneLocalSelectionState(state ?? snapshot())
          if (!next) return

          clearLocalSelectionHandoff(localDraftSelectionHandoffID(sdk.directory))
          // The created session can remount in a different workbench content
          // owner even when its directory is unchanged. Publish the atomic
          // create config through the shared handoff before updating this
          // provider's local store, so that remount does not briefly expose an
          // unconfigured composer while its deferred config query catches up.
          setLocalSelectionHandoff(session, next)
          if (dir === sdk.directory) {
            // The create request already persisted this exact state atomically.
            // Install it locally without scheduling a redundant config PATCH.
            setSaved("session", session, next)
            setStore("draft", undefined)
            return
          }

          setStore("draft", undefined)
        },
        restore: (msg: { sessionID: string; agent: string; model: ModelKey }) => {
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

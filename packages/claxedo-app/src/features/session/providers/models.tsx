import { asRecord, readString } from "@/lib/record"
import { createMemo, createRoot, getOwner, runWithOwner, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { uniqueBy } from "remeda"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useProviders } from "@/features/session/app-ports"
import { Persist, persisted } from "@/platform/persistence/persist"
import type { ModelKey } from "@/features/session/composer/model-strategy"

type Visibility = "show" | "hide"
/** A recent choice always names the harness it was made under. */
export type RecentModel = ModelKey & { harness: string }

/**
 * What one (server, workspace) remembers about models.
 *
 * The bucket is the workspace; the harness is a key INSIDE it, because two
 * harnesses in the same workspace do not share a model namespace: a variant
 * chosen for `anthropic/claude-opus-4` under OpenCode is meaningless for the
 * same pair offered by `claude-sdk`.
 */
export type ModelStoreRecord = {
  /** Recent models, newest first, each carrying the harness it was chosen under. */
  recent: RecentModel[]
  /** Variant per harness, then per `providerID/modelID`. */
  variant: Record<string, Record<string, string | undefined>>
}

const RECENT_LIMIT = 5
const STORE_KEY = "model"
const VISIBILITY_KEY = "model-visibility"

/**
 * Which models and which whole groups the user hid or showed. One answer for
 * the whole app: a model hidden in Settings is hidden in every workspace and
 * under every harness that offers that provider/model pair.
 *
 * `entries` is keyed `providerID:modelID`, `groups` by the group key its
 * models were listed under — a provider id for a catalog harness, `<harness>/
 * <vendor>` for a harness that reports one list across many vendors. The two
 * are separate maps because a group answer must survive the models moving in
 * and out of it, which a prefix scan over `entries` could not do.
 */
export type ModelVisibilityRecord = {
  entries: Record<string, Visibility>
  groups: Record<string, Visibility>
}

function visibilityMap(value: unknown): Record<string, Visibility> {
  const row = asRecord(value)
  if (!row) return {}
  return Object.fromEntries(
    Object.entries(row).filter((entry): entry is [string, Visibility] => entry[1] === "show" || entry[1] === "hide"),
  )
}

export function decodeModelVisibilityRecord(value: unknown): ModelVisibilityRecord {
  const row = asRecord(value)
  return { entries: visibilityMap(row?.entries), groups: visibilityMap(row?.groups) }
}
/**
 * The single global store this one replaces. `persisted` moves it into the
 * first (server, workspace) bucket that reads it and removes it on the way, so
 * the global entry exists for exactly one read.
 */

function variantMap(value: unknown): Record<string, string | undefined> {
  const row = asRecord(value)
  if (!row) return {}
  return Object.fromEntries(
    Object.entries(row).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

/** Validates the workspace-owned, harness-keyed preference record. */
export function decodeModelStoreRecord(value: unknown): ModelStoreRecord {
  const empty: ModelStoreRecord = { recent: [], variant: {} }
  const row = asRecord(value)
  if (!row) return empty
  // The pre-workspace global record carried its preferences as a flat array
  // under `user`; it is rejected whole rather than partially adopted.
  if (Array.isArray(row.user)) return empty
  const variantRow = asRecord(row.variant)
  const variant = variantRow
    ? Object.fromEntries(Object.entries(variantRow).map(([harness, map]) => [harness, variantMap(map)]))
    : {}
  const recent = Array.isArray(row.recent)
    ? row.recent.flatMap((item: unknown) => {
      const entry = asRecord(item)
      const providerID = readString(entry, "providerID")
      const modelID = readString(entry, "modelID")
      const harness = readString(entry, "harness")
      if (!providerID || !modelID || !harness) return []
      return [{ providerID, modelID, harness }]
    })
    : []
  return { recent, variant }
}

/**
 * Loads the full model detail for every CONNECTED provider.
 *
 * The boot catalog is an index (default model per connected provider only), so
 * this is the single mechanism that turns "the picker shows one model per
 * provider" into "the picker shows the provider's whole model set". Failures
 * are per-provider and non-fatal: a provider whose detail fetch fails keeps
 * its index entry rather than emptying the list.
 */
export function hydrateConnectedProviderDetails(providers: {
  connected: () => Array<{ id: string }>
  load: (providerId: string) => Promise<void>
}) {
  return Promise.allSettled(providers.connected().map((provider) => providers.load(provider.id)))
}

function modelKey(model: ModelKey) {
  return `${model.providerID}:${model.modelID}`
}

export function resolveModelVisibility(input: {
  model: ModelKey
  defaults: Record<string, string>
  user?: Visibility
  /** The answer for the whole group this model was listed under. */
  group?: Visibility
  /** False when the harness reports a model it currently holds no credential for. */
  connected?: boolean
}) {
  if (input.user === "hide") return false
  if (input.user === "show") return true
  if (input.group === "hide") return false
  if (input.group === "show") return true
  // A harness that reports its own catalog reports vendors it cannot reach:
  // Pi ships ~1350 models and can run the handful its credentials cover. The
  // offer is what it can run, not what it can name.
  if (input.connected === false) return false
  // A provider with a catalog default is the models.dev registry, where only
  // the default is offered until the user enables more. A harness that reports
  // its own list has no defaults, and that list is already the offer.
  const fallback = input.defaults[input.model.providerID]
  return fallback === undefined || fallback === input.model.modelID
}

export type ModelsScope = {
  /** The persistence bucket: `workspaceId` where the workspace has one, else its directory. */
  workspaceKey: Accessor<string>
  /** The harness whose catalog this store shows and whose maps it keys. */
  harness: Accessor<string>
  /** Only native selections may read the control-plane provider catalog. */
  nativeHarness?: Accessor<string | undefined>
  /** The server serving that workspace. */
  serverUrl: Accessor<string>
  /**
   * The (workspace-or-directory) scope the catalog read is keyed by. Omitted
   * inside a workspace SDK scope, which resolves its own stable identity.
   */
  scope?: Accessor<string | undefined>
}

/** One workspace's persisted model document, backed by its own storage target. */
function createModelStoreRecord(target: ReturnType<typeof Persist.serverWorkspace>) {
  return persisted(
    {
      ...target,
      migrate: decodeModelStoreRecord,
    },
    createStore<ModelStoreRecord>({
      recent: [],
      variant: {},
    }),
  )
}

function createModelVisibilityRecord() {
  return persisted(
    { ...Persist.global(VISIBILITY_KEY), migrate: decodeModelVisibilityRecord },
    createStore<ModelVisibilityRecord>({ entries: {}, groups: {} }),
  )
}

export type ModelStoreRegistry = {
  /** The one record for this (server, workspace), created on first ask. */
  record: (serverUrl: string, workspaceKey: string) => ReturnType<typeof createModelStoreRecord>
  /** The one visibility record for the app, created on first ask. */
  visibility: () => ReturnType<typeof createModelVisibilityRecord>
}

/**
 * The persisted model records this app session holds, one per (server, workspace).
 *
 * Two surfaces are routinely open on one workspace at the same time — a pane's
 * composer and the Settings Models page — and both edit that workspace's single
 * document, so both hold the SAME record: an edit on one is an edit on the
 * other, and neither can overwrite the other on unmount. The registry keeps each
 * record for the shell's lifetime, because a record outlives any one pane or
 * dialog.
 *
 * The harness is deliberately NOT part of the key: it keys the maps INSIDE the
 * record, which is what lets one workspace's harnesses keep separate variants
 * and recents in one document. Visibility is not in the record at all; it is
 * one app-wide document, because a hidden model is hidden everywhere.
 */
export const { use: useModelStoreRegistry, provider: ModelStoreRegistryProvider } =
  createSimpleContext<ModelStoreRegistry, Record<string, unknown>>({
    name: "ModelStoreRegistry",
    gate: false,
    init: (): ModelStoreRegistry => {
      const owner = getOwner()
      const records = new Map<string, ReturnType<typeof createModelStoreRecord>>()
      let visibility: ReturnType<typeof createModelVisibilityRecord> | undefined
      return {
        visibility() {
          visibility ??= owner
            ? runWithOwner(owner, () => createModelVisibilityRecord())!
            : createRoot(() => createModelVisibilityRecord())
          return visibility
        },
        record(serverUrl, workspaceKey) {
          // Keyed by the persistence TARGET rather than by the raw arguments:
          // two callers can name one document with differently-spelled server
          // URLs (`sdk.url` in a pane, `getClaxedoServerUrl()` in Settings),
          // and the target is where that spelling is already normalized away.
          const target = Persist.serverWorkspace(serverUrl, workspaceKey, STORE_KEY)
          const id = `${target.storage ?? ""}:${target.key}`
          const existing = records.get(id)
          if (existing) return existing
          // Owned by the registry, not by the mount that asked first, so the
          // record's write effect lives exactly as long as the record.
          const created = owner
            ? runWithOwner(owner, () => createModelStoreRecord(target))!
            : createRoot(() => createModelStoreRecord(target))
          records.set(id, created)
          return created
        },
      }
    },
  })

const modelsContextInput = {
  name: "Models", gate: true,
  init: (input: ModelsScope) => {
    const providers = useProviders(() => input.nativeHarness?.() ?? "", input.scope ?? (() => undefined))

    const registry = useModelStoreRegistry()
    const [store, setStore, _, ready] = registry.record(input.serverUrl(), input.workspaceKey())
    const [visibilityStore, setVisibilityStore] = registry.visibility()

    const harness = () => input.harness()

    const available = createMemo(() =>
      providers.connected().flatMap((p) =>
        Object.values(p.models)
          .map((m) => ({
            ...m,
            provider: p,
          })),
      ),
    )

    const list = createMemo(() =>
      available().map((m) => ({
        ...m,
        name: m.name.replace("(latest)", "").trim(),
        latest: m.name.includes("(latest)"),
      })),
    )

    const find = (key: ModelKey) => list().find((m) => m.id === key.modelID && m.provider.id === key.providerID)

    const visible = (model: ModelKey, defaults: Record<string, string> = providers.default()) => {
      return resolveModelVisibility({
        model,
        defaults,
        user: visibilityStore.entries[modelKey(model)],
      })
    }

    const setVisibility = (model: ModelKey, state: boolean) => {
      setVisibilityStore("entries", modelKey(model), state ? "show" : "hide")
    }

    /** Recent is per user, filtered to the harness the entries were chosen under. */
    const recentForHarness = createMemo(() =>
      store.recent.filter((entry) => entry.harness === harness()).map(({ harness: _harness, ...model }) => model),
    )

    const push = (model: ModelKey) => {
      const entry: RecentModel = { ...model, harness: harness() }
      const uniq = uniqueBy([entry, ...store.recent], (x) => `${x.harness}:${x.providerID}:${x.modelID}`)
      const mine = uniq.filter((item) => item.harness === entry.harness)
      const others = uniq.filter((item) => item.harness !== entry.harness)
      setStore("recent", [...mine.slice(0, RECENT_LIMIT), ...others])
    }

    // PRODUCT DECISION (provider catalog as an index): boot fetches only the
    // provider INDEX — every provider's id/name plus the one default model per
    // CONNECTED provider — so `list()` starts as defaults-only. The full model
    // set for connected providers is fetched lazily, when a model picker is
    // actually opened (`ModelList` calls `hydrate` on mount). `providers.load`
    // single-flights per provider and merges each `GET /provider with ?provider=<id>`
    // detail into the same query cache, so repeated opens cost nothing.
    const hydrate = () => hydrateConnectedProviderDetails(providers)

    const variantKey = (model: ModelKey) => `${model.providerID}/${model.modelID}`
    const getVariant = (model: ModelKey) => store.variant[harness()]?.[variantKey(model)]

    const setVariant = (model: ModelKey, value: string | undefined) => {
      const key = variantKey(model)
      if (!store.variant[harness()]) {
        setStore("variant", harness(), { [key]: value })
        return
      }
      setStore("variant", harness(), key, value)
    }

    return {
      ready,
      harness,
      list,
      find,
      hydrate,
      visible,
      setVisibility,
      /** Whether the catalog answered at all — an empty list is reported, never implied. */
      catalog: {
        loading: providers.loading,
        error: providers.error,
        empty: () => providers.all().size === 0,
      },
      recent: {
        list: recentForHarness,
        push,
      },
      variant: {
        get: getVariant,
        set: setVariant,
      },
    }
  },
}
export const { use: useModels, provider: ModelsProvider } =
  createSimpleContext<ReturnType<typeof modelsContextInput.init>, ModelsScope>(modelsContextInput)

/** What the caller knows about where a model was listed, beyond the key itself. */
export type ModelVisibilityContext = {
  defaults?: Record<string, string>
  /** The group key the model was listed under, whose answer covers all of them. */
  group?: string
  connected?: boolean
}

/** The visibility answer alone, for surfaces that edit it without a workspace's model store. */
export function useModelVisibility() {
  const [store, setStore] = useModelStoreRegistry().visibility()
  return {
    visible: (model: ModelKey, context: ModelVisibilityContext = {}) =>
      resolveModelVisibility({
        model,
        defaults: context.defaults ?? {},
        user: store.entries[modelKey(model)],
        ...(context.group === undefined ? {} : { group: store.groups[context.group] }),
        ...(context.connected === undefined ? {} : { connected: context.connected }),
      }),
    setVisibility: (model: ModelKey, state: boolean) => {
      setStore("entries", modelKey(model), state ? "show" : "hide")
    },
    groupVisibility: (group: string) => store.groups[group],
    /**
     * Answers for a whole group, and drops the per-model answers it would
     * otherwise lose to: a model switched off by hand stays off against an
     * "enable all" that is supposed to turn the group on.
     */
    setGroupVisibility: (group: string, state: boolean, models: readonly ModelKey[]) => {
      setStore("groups", group, state ? "show" : "hide")
      setStore("entries", (entries) => {
        const next = { ...entries }
        for (const model of models) delete next[modelKey(model)]
        return next
      })
    },
  }
}

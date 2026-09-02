import { createMemo, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { uniqueBy } from "remeda"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useProviders } from "@/features/session/app-ports"
import { Persist, persisted } from "@/platform/persistence/persist"
import type { ModelKey } from "@/features/session/composer/model-strategy"
import { isSignedWorkspaceDefaultModel } from "@/features/session/composer/signed-workspace-model"

type Visibility = "show" | "hide"
type User = ModelKey & { visibility: Visibility; favorite?: boolean }
/** A recent choice always names the harness it was made under. */
export type RecentModel = ModelKey & { harness: string }

/**
 * What one (server, workspace) remembers about models.
 *
 * The bucket is the workspace; the harness is a key INSIDE it, because two
 * harnesses in the same workspace do not share a model namespace: hiding
 * `anthropic/claude-opus-4` under OpenCode says nothing about the same pair
 * offered by `claude-sdk`, and a variant chosen for one is meaningless for the
 * other.
 */
export type ModelStoreRecord = {
  /** Visibility overrides per harness. */
  user: Record<string, User[]>
  /** Recent models, newest first, each carrying the harness it was chosen under. */
  recent: RecentModel[]
  /** Variant per harness, then per `providerID/modelID`. */
  variant: Record<string, Record<string, string | undefined>>
}

const RECENT_LIMIT = 5
const STORE_KEY = "model"
/**
 * The single global store this one replaces. `persisted` moves it into the
 * first (server, workspace) bucket that reads it and removes it on the way, so
 * the global entry exists for exactly one read.
 */
const LEGACY_GLOBAL_MODEL_KEY = "opencode.global.dat:model"

function modelKeys(value: unknown): ModelKey[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const row = item as Partial<ModelKey>
    if (typeof row.providerID !== "string" || typeof row.modelID !== "string") return []
    return [{ providerID: row.providerID, modelID: row.modelID }]
  })
}

function visibilityRows(value: unknown): User[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const row = item as Partial<User>
    if (typeof row.providerID !== "string" || typeof row.modelID !== "string") return []
    if (row.visibility !== "show" && row.visibility !== "hide") return []
    return [{ providerID: row.providerID, modelID: row.modelID, visibility: row.visibility }]
  })
}

function variantMap(value: unknown): Record<string, string | undefined> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

/**
 * Read a stored payload in either shape.
 *
 * The replaced global store was OpenCode's alone — one flat `user` list, one
 * flat `variant` map, `recent` entries with no harness — so its rows are
 * re-homed under `opencode` and everything else starts empty.
 */
export function decodeModelStoreRecord(value: unknown, legacyHarness: string): ModelStoreRecord {
  const empty: ModelStoreRecord = { user: {}, recent: [], variant: {} }
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty
  const row = value as Record<string, unknown>
  // The replaced shape is recognisable by its flat `user` LIST; the current one
  // keys `user` by harness.
  if (Array.isArray(row.user)) {
    return {
      user: { [legacyHarness]: visibilityRows(row.user) },
      recent: modelKeys(row.recent).map((model) => ({ ...model, harness: legacyHarness })),
      variant: { [legacyHarness]: variantMap(row.variant) },
    }
  }
  const user = row.user && typeof row.user === "object" && !Array.isArray(row.user)
    ? Object.fromEntries(Object.entries(row.user).map(([harness, rows]) => [harness, visibilityRows(rows)]))
    : {}
  const variant = row.variant && typeof row.variant === "object" && !Array.isArray(row.variant)
    ? Object.fromEntries(Object.entries(row.variant).map(([harness, map]) => [harness, variantMap(map)]))
    : {}
  const recent = Array.isArray(row.recent)
    ? row.recent.flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const entry = item as Partial<RecentModel>
      if (typeof entry.providerID !== "string" || typeof entry.modelID !== "string") return []
      if (typeof entry.harness !== "string" || !entry.harness) return []
      return [{ providerID: entry.providerID, modelID: entry.modelID, harness: entry.harness }]
    })
    : []
  return { user, recent, variant }
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
}) {
  if (input.user === "hide") return false
  if (input.user === "show") return true
  return input.defaults[input.model.providerID] === input.model.modelID
}

export type ModelsScope = {
  /** The persistence bucket: `workspaceId` where the workspace has one, else its directory. */
  workspaceKey: Accessor<string>
  /** The harness whose catalog this store shows and whose maps it keys. */
  harness: Accessor<string>
  /** The server serving that workspace. */
  serverUrl: Accessor<string>
  /**
   * The (workspace-or-directory) scope the catalog read is keyed by. Omitted
   * inside a workspace SDK scope, which resolves its own stable identity.
   */
  scope?: Accessor<string | undefined>
}

const modelsContextInput = {
  name: "Models", gate: true,
  init: (input: ModelsScope) => {
    const providers = useProviders(input.harness, input.scope ?? (() => undefined))

    const [store, setStore, _, ready] = persisted(
      {
        ...Persist.serverWorkspace(input.serverUrl(), input.workspaceKey(), STORE_KEY, [LEGACY_GLOBAL_MODEL_KEY]),
        migrate: (value: unknown) => decodeModelStoreRecord(value, "opencode"),
      },
      createStore<ModelStoreRecord>({
        user: {},
        recent: [],
        variant: {},
      }),
    )

    const harness = () => input.harness()

    const available = createMemo(() =>
      providers.connected().flatMap((p) =>
        Object.values(p.models)
          .filter((m) => !isSignedWorkspaceDefaultModel({ id: m.id, provider: { id: p.id } }))
          .map((m) => ({
            ...m,
            provider: p,
          })),
      ),
    )

    const visibility = createMemo(() => {
      const map = new Map<string, Visibility>()
      for (const item of store.user[harness()] ?? []) map.set(`${item.providerID}:${item.modelID}`, item.visibility)
      return map
    })

    const list = createMemo(() =>
      available().map((m) => ({
        ...m,
        name: m.name.replace("(latest)", "").trim(),
        latest: m.name.includes("(latest)"),
      })),
    )

    const find = (key: ModelKey) => list().find((m) => m.id === key.modelID && m.provider.id === key.providerID)

    function update(model: ModelKey, state: Visibility) {
      const current = store.user[harness()]
      if (!current) {
        setStore("user", harness(), [{ ...model, visibility: state }])
        return
      }
      const index = current.findIndex((x) => x.modelID === model.modelID && x.providerID === model.providerID)
      if (index >= 0) {
        setStore("user", harness(), index, (entry) => ({ ...entry, visibility: state }))
        return
      }
      setStore("user", harness(), current.length, { ...model, visibility: state })
    }

    const visible = (model: ModelKey) => {
      return resolveModelVisibility({
        model,
        defaults: providers.default(),
        user: visibility().get(modelKey(model)),
      })
    }

    const setVisibility = (model: ModelKey, state: boolean) => {
      update(model, state ? "show" : "hide")
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

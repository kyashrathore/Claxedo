import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { uniqueBy } from "remeda"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useProviders } from "@/features/session/app-ports"
import { Persist, persisted } from "@/platform/persistence/persist"
import type { ModelKey } from "@/features/session/composer/model-strategy"
import { isSignedWorkspaceDefaultModel } from "@/features/session/composer/signed-workspace-model"

type Visibility = "show" | "hide"
type User = ModelKey & { visibility: Visibility; favorite?: boolean }
type Store = {
  user: User[]
  recent: ModelKey[]
  variant?: Record<string, string | undefined>
}

const RECENT_LIMIT = 5

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

const modelsContextInput = {
  name: "Models", gate: true,
  init: () => {
    const providers = useProviders()

    const [store, setStore, _, ready] = persisted(
      Persist.global("model", ["model.v1"]),
      createStore<Store>({
        user: [],
        recent: [],
        variant: {},
      }),
    )

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
      for (const item of store.user) map.set(`${item.providerID}:${item.modelID}`, item.visibility)
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
      const index = store.user.findIndex((x) => x.modelID === model.modelID && x.providerID === model.providerID)
      if (index >= 0) {
        setStore("user", index, (current) => ({ ...current, visibility: state }))
        return
      }
      setStore("user", store.user.length, { ...model, visibility: state })
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

    const push = (model: ModelKey) => {
      const uniq = uniqueBy([model, ...store.recent], (x) => `${x.providerID}:${x.modelID}`)
      if (uniq.length > RECENT_LIMIT) uniq.pop()
      setStore("recent", uniq)
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
    const getVariant = (model: ModelKey) => store.variant?.[variantKey(model)]

    const setVariant = (model: ModelKey, value: string | undefined) => {
      const key = variantKey(model)
      if (!store.variant) {
        setStore("variant", { [key]: value })
        return
      }
      setStore("variant", key, value)
    }

    return {
      ready,
      list,
      find,
      hydrate,
      visible,
      setVisibility,
      recent: {
        list: createMemo(() => store.recent),
        push,
      },
      variant: {
        get: getVariant,
        set: setVariant,
      },
    }
  },
}
export const { use: useModels, provider: ModelsProvider } = createSimpleContext<ReturnType<typeof modelsContextInput.init>, Record<string, any>>(modelsContextInput)

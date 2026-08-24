import { storePath } from "solid-js"
import { Persist, persisted } from "@/platform/persistence/persist"
import { createSignal, type Accessor } from "solid-js"
import { createStore } from "solid-js"
import type { OnboardingStepId } from "./registry"
import type { OnboardingGoFurtherCardId } from "./go-further"

export type OnboardingDismissalId =
  "setup" | "checklist" | `step:${OnboardingStepId}` | `gofurther:${OnboardingGoFurtherCardId}`

export type OnboardingDismissals = {
  ids: Accessor<readonly OnboardingDismissalId[]>
  ready: Accessor<boolean>
  loaded: Promise<void>
  isDismissed: (id: OnboardingDismissalId) => boolean
  dismiss: (id: OnboardingDismissalId) => Promise<void>
}

export type HostedOnboardingDismissalKV = {
  get: (userId: string) => Promise<readonly OnboardingDismissalId[] | undefined>
  set: (userId: string, ids: readonly OnboardingDismissalId[]) => Promise<void>
}

export const ONBOARDING_DISMISSALS_TARGET = Persist.global("onboarding.dismissals.v1")

export function createLocalOnboardingDismissals(): OnboardingDismissals {
  const [store, setStore, init, ready] = persisted(
    ONBOARDING_DISMISSALS_TARGET,
    createStore<{ ids: OnboardingDismissalId[] }>({ ids: [] }),
  )
  const loaded = Promise.resolve(init).then(() => undefined)
  const ids = () => store.ids

  return {
    ids,
    ready,
    loaded,
    isDismissed: (id) => store.ids.includes(id),
    dismiss: async (id) => {
      await loaded
      if (store.ids.includes(id)) return
      setStore(storePath("ids", (current) => [...current, id]))
    },
  }
}

export function createHostedOnboardingDismissals(
  userId: string,
  kv: HostedOnboardingDismissalKV,
): OnboardingDismissals {
  const [ids, setIds] = createSignal<readonly OnboardingDismissalId[]>([])
  const [ready, setReady] = createSignal(false)
  const loaded = kv.get(userId).then((stored) => {
    setIds(stored ? [...new Set(stored)] : [])
    setReady(true)
  })
  let writes = loaded

  return {
    ids,
    ready,
    loaded,
    isDismissed: (id) => ids().includes(id),
    dismiss: async (id) => {
      await loaded
      writes = writes
        .catch(() => undefined)
        .then(async () => {
          if (ids().includes(id)) return
          const next = [...ids(), id]
          await kv.set(userId, next)
          setIds(next)
        })
      await writes
    },
  }
}

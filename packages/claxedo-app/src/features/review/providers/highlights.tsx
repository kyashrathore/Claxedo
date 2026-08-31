import { createEffect } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { persisted } from "@/platform/persistence/persist"

type Store = {
  version?: string
}

const highlightsContextInput = {
  name: "Highlights",
  gate: false,
  init: () => {
    const platform = usePlatform()
    const [store, setStore, _, ready] = persisted("highlights.v1", createStore<Store>({ version: undefined }))

    const [range, setRange] = createStore({
      from: undefined as string | undefined,
      to: undefined as string | undefined,
    })
    const state = { started: false }

    const markSeen = () => {
      if (!platform.version) return
      setStore("version", platform.version)
    }

    createEffect(() => {
      if (state.started) return
      if (!ready()) return
      if (!platform.version) return
      state.started = true

      const previous = store.version
      if (!previous) {
        setStore("version", platform.version)
        return
      }

      if (previous === platform.version) return

      setRange({ from: previous, to: platform.version })
      markSeen()
    })

    return {
      ready,
      from: () => range.from,
      to: () => range.to,
      get last() {
        return store.version
      },
      markSeen,
    }
  },
}
export const { use: useHighlights, provider: HighlightsProvider } = createSimpleContext<ReturnType<typeof highlightsContextInput.init>, Record<string, any>>(highlightsContextInput)

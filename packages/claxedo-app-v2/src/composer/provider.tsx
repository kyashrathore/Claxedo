import type { ParentProps } from "solid-js"
import { useServer } from "@/server"
import { HarnessConfigContext } from "./harness/context"
import { createHarnessConfigStore } from "./harness/harness-config-store"
import { ComposerStoreContext, createComposerStore } from "./store"

export function ComposerStoreProvider(props: ParentProps) {
  const store = createComposerStore()
  const harness = createHarnessConfigStore(useServer(), localStorage)
  return (
    <ComposerStoreContext.Provider value={store}>
      <HarnessConfigContext.Provider value={harness}>{props.children}</HarnessConfigContext.Provider>
    </ComposerStoreContext.Provider>
  )
}

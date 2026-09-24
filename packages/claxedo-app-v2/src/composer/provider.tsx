import type { ParentProps } from "solid-js"
import { useServer } from "@/server"
import { HarnessConfigContext } from "./harness/context"
import { createHarnessConfigStore } from "./harness/harness-config-store"
import { createComposerPersistence } from "./persistence"
import { ComposerStoreContext, createComposerStore } from "./store"

export function ComposerStoreProvider(props: ParentProps) {
  const server = useServer()
  const store = createComposerStore(createComposerPersistence(localStorage, server.harnessConfig.serverUrl))
  const harness = createHarnessConfigStore(server, localStorage)
  return (
    <ComposerStoreContext.Provider value={store}>
      <HarnessConfigContext.Provider value={harness}>{props.children}</HarnessConfigContext.Provider>
    </ComposerStoreContext.Provider>
  )
}

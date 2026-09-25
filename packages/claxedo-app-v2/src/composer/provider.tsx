import { onCleanup, type ParentProps } from "solid-js"
import { useServer } from "@/server"
import { HarnessConfigContext } from "./harness/context"
import { createHarnessConfigStore } from "./harness/harness-config-store"
import { createDeferredPersistence } from "./deferred-persistence"
import { createComposerPersistence } from "./persistence"
import { ComposerStoreContext, createComposerStore } from "./store"

export function ComposerStoreProvider(props: ParentProps) {
  const server = useServer()
  const persistence = createDeferredPersistence(createComposerPersistence(localStorage, server.harnessConfig.serverUrl), window)
  onCleanup(persistence.dispose)
  const store = createComposerStore(persistence)
  const harness = createHarnessConfigStore(server, localStorage)
  return (
    <ComposerStoreContext.Provider value={store}>
      <HarnessConfigContext.Provider value={harness}>{props.children}</HarnessConfigContext.Provider>
    </ComposerStoreContext.Provider>
  )
}

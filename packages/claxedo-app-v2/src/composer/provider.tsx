import { onCleanup, type ParentProps } from "solid-js"
import { useServer } from "@/server"
import { HarnessConfigContext, ModelPreferencesContext } from "./harness/context"
import { createHarnessConfigStore } from "./harness/harness-config-store"
import { createModelNames } from "./harness/model-names"
import { createModelVisibility } from "./harness/model-visibility"
import { createDeferredPersistence } from "./deferred-persistence"
import { createComposerPersistence } from "./persistence"
import { ComposerStoreContext, createComposerStore } from "./store"

export function ComposerStoreProvider(props: ParentProps) {
  const server = useServer()
  const persistence = createDeferredPersistence(createComposerPersistence(localStorage, server.harnessConfig.serverUrl), window)
  onCleanup(persistence.dispose)
  const store = createComposerStore(persistence)
  const harness = createHarnessConfigStore(server, localStorage)
  const models = { names: createModelNames(), visibility: createModelVisibility() }
  return (
    <ComposerStoreContext.Provider value={store}>
      <HarnessConfigContext.Provider value={harness}>
        <ModelPreferencesContext.Provider value={models}>{props.children}</ModelPreferencesContext.Provider>
      </HarnessConfigContext.Provider>
    </ComposerStoreContext.Provider>
  )
}

import type { ParentProps } from "solid-js"
import { ComposerStoreContext, createComposerStore } from "./store"

export function ComposerStoreProvider(props: ParentProps) {
  const store = createComposerStore()
  return <ComposerStoreContext.Provider value={store}>{props.children}</ComposerStoreContext.Provider>
}

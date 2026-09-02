import type { PanePreferenceStorage } from "@/features/session/preferences/pane"
import {
  initialHarnessStoreState,
  type HarnessStoreState,
} from "./store-state"
import { createDraftDefaultPreferences } from "./draft-defaults"

type HarnessPreferenceKind = "harness" | "model" | "agent"

export function createHarnessPreferences(storage: PanePreferenceStorage) {
  return {
    draftDefaults: createDraftDefaultPreferences(storage),
    initialState(scope: string): HarnessStoreState {
      return initialHarnessStoreState({ scope })
    },
    save(_scope: string, _key: HarnessPreferenceKind, _value: string) {
      // A harness/model choice is persisted by the draft defaults (a new draft)
      // or by session config (an existing session). Nothing is pane-scoped.
    },
    promote(_from: string, _to: string) {
      // Draft-to-session promotion copies transient state in harness-store.
    },
  }
}

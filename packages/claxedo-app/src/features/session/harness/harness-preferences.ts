import type { PanePreferenceStorage } from "@/features/session/preferences/pane"
import { initialHarnessStoreState, type HarnessStoreState } from "./store-state"
import { createDraftDefaultPreferences } from "./draft-defaults"

const LEGACY_MODEL_KEY = "claxedo:acp-model"
const LEGACY_RUNNER_KEY = "claxedo:runner"
const LEGACY_AGENT_KEY = "claxedo:agent-mode"
const LEGACY_HARNESS_MAP_KEY = "claxedo:runner-map"
const HARNESS_MAP_KEY = "claxedo:harness-map"
const MODEL_MAP_KEY = "claxedo:acp-model-map"
const AGENT_MAP_KEY = "claxedo:agent-mode-map"

type HarnessPreferenceKind = "harness" | "model" | "agent"

function parse(input: string | null): Record<string, string> {
  if (!input) return {}
  try {
    const value = JSON.parse(input)
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    )
  } catch {
    return {}
  }
}

function readOnlyMaps(storage: PanePreferenceStorage) {
  return {
    harness: {
      ...parse(storage.getItem(LEGACY_HARNESS_MAP_KEY)),
      ...parse(storage.getItem(HARNESS_MAP_KEY)),
    },
    model: parse(storage.getItem(MODEL_MAP_KEY)),
    agent: parse(storage.getItem(AGENT_MAP_KEY)),
  }
}

export function createHarnessPreferences(storage: PanePreferenceStorage) {
  const maps = readOnlyMaps(storage)
  return {
    draftDefaults: createDraftDefaultPreferences(storage),
    initialState(scope: string): HarnessStoreState {
      return initialHarnessStoreState({
        scope,
        savedHarness: maps.harness[scope],
        savedModel: maps.model[scope],
        savedAgent: maps.agent[scope],
        legacyHarness: storage.getItem(LEGACY_RUNNER_KEY),
        legacyModel: storage.getItem(LEGACY_MODEL_KEY),
        legacyAgent: storage.getItem(LEGACY_AGENT_KEY),
      })
    },
    save(_scope: string, _key: HarnessPreferenceKind, _value: string) {
      // Read-only migration: old harness/model/agent pane maps can seed the
      // transient store, but new choices are persisted by session config.
    },
    promote(_from: string, _to: string) {
      // Draft-to-session promotion copies transient state in harness-store.
    },
  }
}

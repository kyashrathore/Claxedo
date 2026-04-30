import type { ReviewMode } from "../../claxedo-ui/workspace-panel/review-intent"
import { createStoragePanePrefsBackend } from "../../shared/data/http-backend"

export type PanePreferenceKind = "runner" | "model" | "agent" | "variant" | "reviewMode"

export type PanePreferenceScopeInput = {
  directory?: string
  sessionId?: string
  surfaceId?: string
  draftId?: string
}

export type PanePreferenceStorage = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export const PANE_PREFERENCE_KEYS = {
  runner: "claxedo:runner-map",
  model: "claxedo:acp-model-map",
  agent: "claxedo:agent-mode-map",
  variant: "claxedo:model-variant-map",
  reviewMode: "claxedo:review-mode-map",
} as const satisfies Record<PanePreferenceKind, string>

type PanePreferenceMaps = Record<PanePreferenceKind, Record<string, string>>

function parse(input: string | null) {
  if (!input) return {}
  try {
    const value = JSON.parse(input)
    return value && typeof value === "object" ? (value as Record<string, string>) : {}
  } catch {
    return {}
  }
}

export function panePreferenceScope(input: PanePreferenceScopeInput) {
  if (input.sessionId && input.sessionId !== "new") return `session:${input.directory ?? ""}:${input.sessionId}`
  if (input.draftId) return `draft:${input.draftId}`
  return `draft:${input.directory ?? ""}:${input.surfaceId ?? "route"}`
}

export function isDraftPaneScope(scope: string) {
  return scope.startsWith("draft:")
}

export function initialPaneRunner(scope: string, saved?: string, legacy?: string | null) {
  return saved ?? (isDraftPaneScope(scope) ? undefined : legacy ?? undefined)
}

export function initialPaneValue(scope: string, saved?: string, legacy?: string | null) {
  return saved ?? (isDraftPaneScope(scope) ? "" : legacy ?? "")
}

export function defaultReviewMode(_sessionId?: string): ReviewMode {
  return "uncommitted"
}

export function reviewModePreferenceScope(input: { directory?: string; sessionId?: string }) {
  return panePreferenceScope({
    directory: input.directory,
    sessionId: input.sessionId,
  })
}

export function createPanePreferences(storage: PanePreferenceStorage) {
  const backend = createStoragePanePrefsBackend(storage)
  const maps = {
    runner: backend.getMap("runner"),
    model: backend.getMap("model"),
    agent: backend.getMap("agent"),
    variant: backend.getMap("variant"),
    reviewMode: backend.getMap("reviewMode"),
  } satisfies PanePreferenceMaps

  const save = (kind: PanePreferenceKind) => {
    backend.setMap(kind, maps[kind])
  }

  return {
    maps,
    get(kind: PanePreferenceKind, scope: string) {
      return maps[kind][scope]
    },
    set(kind: PanePreferenceKind, scope: string, value?: string) {
      if (value) maps[kind][scope] = value
      else delete maps[kind][scope]
      save(kind)
    },
    promote(from: string, to: string, kinds?: PanePreferenceKind[]) {
      for (const kind of kinds ?? (Object.keys(PANE_PREFERENCE_KEYS) as PanePreferenceKind[])) {
        const value = maps[kind][from]
        if (value) maps[kind][to] = value
        else delete maps[kind][to]
        save(kind)
      }
    },
    reviewMode(input: { directory?: string; sessionId?: string; fallback?: ReviewMode }) {
      const stored = this.get("reviewMode", reviewModePreferenceScope(input)) as ReviewMode | undefined
      return stored ?? input.fallback ?? defaultReviewMode(input.sessionId)
    },
  }
}

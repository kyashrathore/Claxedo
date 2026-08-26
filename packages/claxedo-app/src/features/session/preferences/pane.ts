type ReviewMode = "uncommitted" | "unstaged" | "staged" | "to-from"

export type PanePreferenceKind = "variant" | "reviewMode"

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
  variant: "claxedo:model-variant-map",
  reviewMode: "claxedo:review-mode-map",
} as const satisfies Record<PanePreferenceKind, string>

const PANE_PREFERENCE_KINDS = ["variant", "reviewMode"] as const satisfies readonly PanePreferenceKind[]

type PanePreferenceMaps = Record<PanePreferenceKind, Record<string, string>>

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

export function panePreferenceScope(input: PanePreferenceScopeInput) {
  if (input.sessionId && input.sessionId !== "new") return `session:${input.sessionId}`
  if (input.draftId) return `draft:${input.draftId}`
  return `draft:${input.directory ?? ""}:${input.surfaceId ?? "route"}`
}

export function isDraftPaneScope(scope: string) {
  return scope.startsWith("draft:")
}

export function initialPaneHarness(scope: string, saved?: string, legacy?: string | null) {
  return saved ?? (isDraftPaneScope(scope) ? undefined : (legacy ?? undefined))
}

export function initialPaneValue(scope: string, saved?: string, legacy?: string | null) {
  return saved ?? (isDraftPaneScope(scope) ? "" : (legacy ?? ""))
}

export function defaultReviewMode(_sessionId?: string): ReviewMode {
  return "uncommitted"
}

function isReviewMode(value: string | undefined): value is ReviewMode {
  return value === "uncommitted" || value === "unstaged" || value === "staged" || value === "to-from"
}

export function reviewModePreferenceScope(input: { directory?: string; sessionId?: string }) {
  return panePreferenceScope({
    directory: input.directory,
    sessionId: input.sessionId,
  })
}

export function createPanePreferences(storage: PanePreferenceStorage) {
  const maps = {
    variant: parse(storage.getItem(PANE_PREFERENCE_KEYS.variant)),
    reviewMode: parse(storage.getItem(PANE_PREFERENCE_KEYS.reviewMode)),
  } satisfies PanePreferenceMaps

  const save = (kind: PanePreferenceKind) => {
    storage.setItem(PANE_PREFERENCE_KEYS[kind], JSON.stringify(maps[kind]))
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
      for (const kind of kinds ?? PANE_PREFERENCE_KINDS) {
        const value = maps[kind][from]
        if (value) maps[kind][to] = value
        else delete maps[kind][to]
        save(kind)
      }
    },
    reviewMode(input: { directory?: string; sessionId?: string; fallback?: ReviewMode }) {
      const stored = this.get("reviewMode", reviewModePreferenceScope(input))
      if (isReviewMode(stored)) return stored
      return input.fallback ?? defaultReviewMode(input.sessionId)
    },
  }
}

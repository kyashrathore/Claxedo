import { createSignal } from "solid-js"
import { isRecord } from "@claxedo/helpers/guards"

/**
 * What a pane's Review compares: the worktree against the index or HEAD, two
 * refs, or the commit where HEAD left a base (`branch` up to HEAD,
 * `branch-worktree` up to the files on disk).
 */
export type ReviewMode = "uncommitted" | "unstaged" | "staged" | "to-from" | "branch" | "branch-worktree"

/** What a pane reviews: the diff mode, the two refs in `to-from`, and the base as `fromRef` in the branch modes. */
export type ReviewSelection = { mode: ReviewMode; fromRef?: string; toRef?: string }

export type PanePreferenceKind = "reviewMode"

type PanePreferenceValues = { reviewMode: ReviewSelection }

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
  reviewMode: "claxedo:review-mode-map",
} as const satisfies Record<PanePreferenceKind, string>

const PANE_PREFERENCE_KINDS = ["reviewMode"] as const satisfies readonly PanePreferenceKind[]

type PanePreferenceMaps = { [K in PanePreferenceKind]: Record<string, PanePreferenceValues[K]> }

function isReviewMode(value: unknown): value is ReviewMode {
  return value === "uncommitted" || value === "unstaged" || value === "staged" || value === "to-from"
    || value === "branch" || value === "branch-worktree"
}

function optionalRef(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** A stored entry: the object shape, or the bare mode string the key held before refs were persisted. */
function parseReviewSelection(value: unknown): ReviewSelection | undefined {
  if (typeof value === "string") return isReviewMode(value) ? { mode: value } : undefined
  if (!isRecord(value)) return undefined
  if (!isReviewMode(value.mode)) return undefined
  const fromRef = optionalRef(value.fromRef)
  const toRef = optionalRef(value.toRef)
  return {
    mode: value.mode,
    ...(fromRef === undefined ? {} : { fromRef }),
    ...(toRef === undefined ? {} : { toRef }),
  }
}

const PARSE_VALUE = {
  reviewMode: parseReviewSelection,
} satisfies { [K in PanePreferenceKind]: (value: unknown) => PanePreferenceValues[K] | undefined }

function parse<K extends PanePreferenceKind>(kind: K, input: string | null): Record<string, PanePreferenceValues[K]> {
  if (!input) return {}
  try {
    const value: unknown = JSON.parse(input)
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    const map: Record<string, PanePreferenceValues[K]> = {}
    for (const [scope, raw] of Object.entries(value)) {
      const parsed = PARSE_VALUE[kind](raw)
      if (parsed) map[scope] = parsed
    }
    return map
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

export function defaultReviewMode(_sessionId?: string): ReviewMode {
  return "uncommitted"
}

export function reviewModePreferenceScope(input: { directory?: string; sessionId?: string }) {
  return panePreferenceScope({
    directory: input.directory,
    sessionId: input.sessionId,
  })
}

export type PanePreferences = ReturnType<typeof buildPanePreferences>

function buildPanePreferences(storage: PanePreferenceStorage) {
  const maps: PanePreferenceMaps = {
    reviewMode: parse("reviewMode", storage.getItem(PANE_PREFERENCE_KEYS.reviewMode)),
  }
  const [version, setVersion] = createSignal(0)

  const save = (kind: PanePreferenceKind) => {
    storage.setItem(PANE_PREFERENCE_KEYS[kind], JSON.stringify(maps[kind]))
    setVersion((current) => current + 1)
  }

  const get = <K extends PanePreferenceKind>(kind: K, scope: string): PanePreferenceValues[K] | undefined => {
    version()
    return maps[kind][scope]
  }

  return {
    get,
    set<K extends PanePreferenceKind>(kind: K, scope: string, value?: PanePreferenceValues[K]) {
      const map: Record<string, PanePreferenceValues[K]> = maps[kind]
      if (value) map[scope] = value
      else delete map[scope]
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
    reviewSelection(input: { directory?: string; sessionId?: string; fallback?: ReviewSelection }): ReviewSelection {
      return get("reviewMode", reviewModePreferenceScope(input)) ?? input.fallback ?? { mode: defaultReviewMode(input.sessionId) }
    },
  }
}

const instances = new WeakMap<PanePreferenceStorage, PanePreferences>()

/**
 * One instance per storage: every reader of a storage tracks the same version
 * signal, so a write from one pane surface is observed by the others.
 */
export function createPanePreferences(storage: PanePreferenceStorage): PanePreferences {
  const existing = instances.get(storage)
  if (existing) return existing
  const created = buildPanePreferences(storage)
  instances.set(storage, created)
  return created
}

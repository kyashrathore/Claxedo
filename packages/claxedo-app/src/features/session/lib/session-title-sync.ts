export type StableSessionTitle = {
  sessionKey: string
  title: string
  source: "directory" | "inventory" | "provisional" | "placeholder"
  updatedAt?: number
}

export type SessionTitleCandidates = {
  directoryTitle?: string | null
  directoryUpdatedAt?: number
  inventoryTitle?: string | null
  inventoryUpdatedAt?: number
  provisionalTitle?: string | null
}

export function provisionalSessionTitle(text: string) {
  const cleaned = text.replace(/\s+/g, " ").trim()
  if (!cleaned) return undefined
  return cleaned.length > 72 ? cleaned.slice(0, 72).trimEnd() + "…" : cleaned
}

export function stableSessionTitle(
  previous: StableSessionTitle | undefined,
  input: SessionTitleCandidates & { sessionKey?: string },
) {
  if (!input.sessionKey) return undefined
  const prior = previous?.sessionKey === input.sessionKey ? previous : undefined
  const directoryTitle = normalizedTitle(input.directoryTitle)
  if (
    directoryTitleIsConcrete(directoryTitle, input.directoryUpdatedAt, prior) &&
    !isOlderThanPrior(directoryTitle, input.directoryUpdatedAt, prior)
  ) {
    return stableTitle(input.sessionKey, directoryTitle, "directory", input.directoryUpdatedAt)
  }

  if (prior?.source === "directory") return prior

  const provisionalTitle = normalizedTitle(input.provisionalTitle)
  if (provisionalTitle) {
    return { sessionKey: input.sessionKey, title: provisionalTitle, source: "provisional" } satisfies StableSessionTitle
  }

  if (prior?.source === "provisional") return prior
  if (prior?.source === "inventory") return prior

  const inventoryTitle = normalizedTitle(input.inventoryTitle)
  if (isConcreteSessionTitle(inventoryTitle)) {
    return stableTitle(input.sessionKey, inventoryTitle, "inventory", input.inventoryUpdatedAt)
  }
  if (prior) return prior

  const placeholder = directoryTitle ?? inventoryTitle
  if (!placeholder) return undefined
  return { sessionKey: input.sessionKey, title: placeholder, source: "placeholder" } satisfies StableSessionTitle
}

export function resolveSessionTitle(input: SessionTitleCandidates) {
  return stableSessionTitle(undefined, { ...input, sessionKey: "display" })?.title
}

export type LatchedSessionTitle = { sessionKey: string; title: string }

/**
 * A header resolves its title from whichever of several sources answers first,
 * and any of them can go absent for a frame while a session switch settles.
 * Once one has named the session that name stands until another names it
 * differently, so the header never falls back to what it shows before a title
 * exists. Only another session key drops the name; the identical title returns
 * the same value so a repaint needs an actual change.
 */
export function latchSessionTitle(
  previous: LatchedSessionTitle | undefined,
  input: { sessionKey: string | undefined; title: string | undefined },
): LatchedSessionTitle | undefined {
  if (!input.sessionKey) return undefined
  const prior = previous?.sessionKey === input.sessionKey ? previous : undefined
  const title = normalizedTitle(input.title)
  if (!title) return prior
  if (prior?.title === title) return prior
  return { sessionKey: input.sessionKey, title }
}

function stableTitle(
  sessionKey: string,
  title: string,
  source: StableSessionTitle["source"],
  updatedAt: number | undefined,
): StableSessionTitle {
  return { sessionKey, title, source, ...(updatedAt !== undefined ? { updatedAt } : {}) }
}

function isOlderThanPrior(title: string, updatedAt: number | undefined, prior: StableSessionTitle | undefined) {
  if (updatedAt === undefined || prior?.updatedAt === undefined) return false
  return updatedAt < prior.updatedAt || (updatedAt === prior.updatedAt && title !== prior.title)
}

function directoryTitleIsConcrete(
  title: string | undefined,
  updatedAt: number | undefined,
  prior: StableSessionTitle | undefined,
): title is string {
  if (isConcreteSessionTitle(title)) return true
  return !!title &&
    prior?.source === "directory" &&
    title !== prior.title &&
    updatedAt !== undefined &&
    prior.updatedAt !== undefined &&
    updatedAt > prior.updatedAt
}

export function isConcreteSessionTitle(title: string | undefined): title is string {
  if (!title) return false
  if (/^new session$/i.test(title)) return false
  if (/^untitled session$/i.test(title)) return false
  if (/^new session\s*-\s*\d{4}-\d{2}-\d{2}t/i.test(title)) return false
  if (/^child session\s*-\s*\d{4}-\d{2}-\d{2}t/i.test(title)) return false
  if (/^session$/i.test(title)) return false
  return true
}

function normalizedTitle(title: string | null | undefined) {
  const value = title?.replace(/\s+/g, " ").trim()
  return value || undefined
}

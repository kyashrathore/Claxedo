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

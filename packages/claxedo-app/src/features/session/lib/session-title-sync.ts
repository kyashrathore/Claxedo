export type SessionTitleRow = {
  id?: string
  title?: string | null
  directory?: string
  workspaceId?: string
  time?: { created?: number; updated?: number }
  createdAt?: number
  updatedAt?: number
}

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

export type SessionTitleInventory = {
  global?: readonly SessionTitleRow[]
  byWorkspace?: Record<string, { sessions?: readonly SessionTitleRow[] } | undefined>
  byProject?: Record<string, readonly SessionTitleRow[] | undefined>
}

export type SessionTitleInventoryIndex<T extends SessionTitleRow = SessionTitleRow> = ReadonlyMap<string, readonly T[]>

export function sessionTitleSignature(session: SessionTitleRow) {
  return JSON.stringify([
    session.id ?? "",
    session.directory ?? "",
    session.workspaceId ?? "",
    session.title ?? "",
    sessionCreatedAt(session) ?? null,
    sessionUpdatedAt(session) ?? null,
  ])
}

export function sessionTitleFromSources(input: {
  sessionId: string
  directory?: string
  directorySessions?: (directory: string) => readonly SessionTitleRow[]
  inventory?: SessionTitleInventory
  inventoryIndex?: SessionTitleInventoryIndex
  provisionalTitle?: string | null
}) {
  const directorySession = input.directory
    ? input.directorySessions?.(input.directory).find((session) => session.id === input.sessionId)
    : undefined
  const inventorySession = selectSessionTitleInventoryRow({
    sessionId: input.sessionId,
    directory: input.directory,
    index: input.inventoryIndex ?? indexSessionTitleInventory(input.inventory),
  })
  return resolveSessionTitle({
    directoryTitle: directorySession?.title,
    directoryUpdatedAt: sessionUpdatedAt(directorySession),
    inventoryTitle: inventorySession?.title,
    inventoryUpdatedAt: sessionUpdatedAt(inventorySession),
    provisionalTitle: input.provisionalTitle,
  })
}

export function indexSessionTitleInventory<T extends SessionTitleRow>(
  inventory: {
    global?: readonly T[]
    byWorkspace?: Record<string, { sessions?: readonly T[] } | undefined>
    byProject?: Record<string, readonly T[] | undefined>
  } | undefined,
): SessionTitleInventoryIndex<T> {
  const index = new Map<string, T[]>()
  const add = (session: T) => {
    if (!session.id) return
    const rows = index.get(session.id)
    if (rows) {
      if (!rows.includes(session)) rows.push(session)
      return
    }
    index.set(session.id, [session])
  }
  ;(inventory?.global ?? []).forEach(add)
  Object.values(inventory?.byWorkspace ?? {}).forEach((group) => group?.sessions?.forEach(add))
  Object.values(inventory?.byProject ?? {}).forEach((sessions) => sessions?.forEach(add))
  return index
}

export function selectSessionTitleInventoryRow<T extends SessionTitleRow>(input: {
  sessionId: string
  directory?: string
  index: SessionTitleInventoryIndex<T>
}) {
  const rows = (input.index.get(input.sessionId) ?? []).filter((session) => normalizedTitle(session.title))
  const exact = input.directory
    ? rows.filter((session) => session.directory === input.directory || session.workspaceId === input.directory)
    : rows
  const candidates = exact.length > 0
    ? exact
    : rows.filter((session) => !session.directory && !session.workspaceId)
  return candidates.reduce<T | undefined>((best, session) => {
    if (!best) return session
    const concrete = isConcreteSessionTitle(normalizedTitle(session.title))
    const bestConcrete = isConcreteSessionTitle(normalizedTitle(best.title))
    if (concrete !== bestConcrete) return concrete ? session : best
    return (sessionUpdatedAt(session) ?? 0) > (sessionUpdatedAt(best) ?? 0) ? session : best
  }, undefined)
}

export function provisionalSessionTitle(text: string) {
  const cleaned = text.replace(/\s+/g, " ").trim()
  if (!cleaned) return
  return cleaned.length > 72 ? cleaned.slice(0, 72).trimEnd() + "…" : cleaned
}

export function stableSessionTitle(
  previous: StableSessionTitle | undefined,
  input: SessionTitleCandidates & { sessionKey?: string },
) {
  if (!input.sessionKey) return
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
  if (!placeholder) return
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

function sessionCreatedAt(session: SessionTitleRow | undefined) {
  return session?.time?.created ?? session?.createdAt
}

function sessionUpdatedAt(session: SessionTitleRow | undefined) {
  return session?.time?.updated ?? session?.updatedAt
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

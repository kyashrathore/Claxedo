export type SessionTitleRow = {
  id?: string
  title?: string
}

export type SessionTitleInventory = {
  global?: readonly SessionTitleRow[]
  byWorkspace?: Record<string, { sessions?: readonly SessionTitleRow[] } | undefined>
  byProject?: Record<string, readonly SessionTitleRow[] | undefined>
}

export function sessionTitleSignature(session: SessionTitleRow) {
  return `${session.id ?? ""}:${session.title ?? ""}`
}

export function sessionTitleFromSources(input: {
  sessionId: string
  directory?: string
  directorySessions?: (directory: string) => readonly SessionTitleRow[]
  inventory?: SessionTitleInventory
}) {
  const cachedTitle = input.directory
    ? input.directorySessions?.(input.directory).find((session) => session.id === input.sessionId)?.title?.trim()
    : undefined
  if (cachedTitle) return cachedTitle
  for (const session of input.inventory?.global ?? []) {
    const title = session.id === input.sessionId ? session.title?.trim() : undefined
    if (title) return title
  }
  for (const group of Object.values(input.inventory?.byWorkspace ?? {})) {
    for (const session of group?.sessions ?? []) {
      const title = session.id === input.sessionId ? session.title?.trim() : undefined
      if (title) return title
    }
  }
  for (const sessions of Object.values(input.inventory?.byProject ?? {})) {
    for (const session of sessions ?? []) {
      const title = session.id === input.sessionId ? session.title?.trim() : undefined
      if (title) return title
    }
  }
}

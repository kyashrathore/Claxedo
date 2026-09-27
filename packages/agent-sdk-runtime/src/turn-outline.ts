export const TURN_OUTLINE_LIMIT = 500
export const TURN_OUTLINE_SNIPPET_LENGTH = 120

/** One turn as a transcript's outline lists it: what a nav rail needs, read from the turn's user message alone. */
export type TurnOutlineEntry = {
  id: string
  createdAt: number
  title?: string
  user?: string
}

/** The newest turns of a session, oldest first; `complete` is false when turns older than the window exist. */
export type TurnOutline = {
  turns: TurnOutlineEntry[]
  complete: boolean
}

export type OutlineUserRow = { id: string; created_at: number | null; title: string | null }

export type OutlineTextRow = { message_id: string; text: string | null; synthetic: number | null; ignored: number | null }

/**
 * The rows a store reads for the outline's window, all from its user messages:
 * the users oldest first, and their text parts in transcript order, each
 * already cut to the snippet length by the store.
 */
export type OutlineRows = {
  users: readonly OutlineUserRow[]
  texts: readonly OutlineTextRow[]
  complete: boolean
}

function snippet(pieces: string[], length: number): string | undefined {
  const text = pieces.join(" ").replace(/\s+/g, " ").trim().slice(0, length)
  return text.length > 0 ? text : undefined
}

export function foldTurnOutline(rows: OutlineRows, snippetLength = TURN_OUTLINE_SNIPPET_LENGTH): TurnOutline {
  const prompts = new Map<string, string[]>()
  for (const row of rows.texts) {
    if (!row.text || row.synthetic || row.ignored) continue
    const pieces = prompts.get(row.message_id)
    if (pieces) pieces.push(row.text)
    else prompts.set(row.message_id, [row.text])
  }
  return {
    turns: rows.users.map((user) => {
      const prompt = snippet(prompts.get(user.id) ?? [], snippetLength)
      return { id: user.id, createdAt: user.created_at ?? 0, ...(user.title ? { title: user.title } : {}), ...(prompt ? { user: prompt } : {}) }
    }),
    complete: rows.complete,
  }
}

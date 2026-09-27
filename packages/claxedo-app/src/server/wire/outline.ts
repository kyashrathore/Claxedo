import { ServerError } from "../errors"
import type { OutlineTurn, SessionOutline } from "../types"

type WireTurn = {
  id?: unknown
  createdAt?: unknown
  title?: unknown
  user?: unknown
}

function turnFromWire(value: unknown): OutlineTurn | undefined {
  const row = value as WireTurn | null
  if (!row || typeof row.id !== "string") return undefined
  return {
    id: row.id,
    createdAt: typeof row.createdAt === "number" ? row.createdAt : 0,
    ...(typeof row.title === "string" ? { title: row.title } : {}),
    preview: typeof row.user === "string" ? { user: row.user } : {},
  }
}

export function outlineFromWire(body: unknown): SessionOutline | undefined {
  const record = body as { allowed?: unknown; turns?: unknown; complete?: unknown } | null
  if (record?.allowed === false) return undefined
  if (!record || !Array.isArray(record.turns)) throw new ServerError({ class: "internal", message: "The turn outline is not a list of turns" })
  return { turns: record.turns.flatMap((turn) => turnFromWire(turn) ?? []), complete: record.complete === true }
}

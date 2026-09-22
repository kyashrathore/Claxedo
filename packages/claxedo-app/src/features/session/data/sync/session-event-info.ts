import type { AgentPresentationSession as Session, AgentSessionCommand } from "@claxedo/agent-runtime-contract"
import { asRecord, readFiniteNumber, readString } from "@/lib/record"

/**
 * `properties.info` on a `session.*` frame.
 *
 * The envelope reaches the app as `{ type: string; properties?: unknown }` — an
 * SSE frame, not a typed value — and the producers do NOT all publish the
 * same `info`. `session.deleted` carries identity only (the runtime's DELETE
 * route publishes `{ id, directory, parentID? }`), while `session.updated`
 * carries the whole row. Reading the envelope through this module is the one
 * place that difference is stated; a consumer that asserts
 * `properties as { info: Session }` lies for the identity-only arm and throws
 * a TypeError when `info` is absent altogether.
 */

function nonEmpty(value: string | undefined) {
  return value && value.length > 0 ? value : undefined
}

function eventInfo(properties: unknown) {
  return asRecord(asRecord(properties)?.info)
}

/** A replacement command list belongs only to the session named by its agent. */
export function sessionEventCommands(properties: unknown): { sessionID: string; commands: AgentSessionCommand[] } | undefined {
  const row = asRecord(properties)
  if (typeof row?.sessionID !== "string" || !row.sessionID || !Array.isArray(row.commands)) return undefined
  const commands = row.commands
  if (!commands.every((item): item is AgentSessionCommand => {
    const command = asRecord(item)
    if (typeof command?.name !== "string" || typeof command.description !== "string") return false
    return command.input == null || typeof asRecord(command.input)?.hint === "string"
  })) return undefined
  return { sessionID: row.sessionID, commands }
}

/** The session id of a `session.*` event, read from `info.id`. */
export function sessionEventInfoId(properties: unknown): string | undefined {
  return nonEmpty(readString(eventInfo(properties), "id"))
}

/** The workspace `info` was stamped with, under either spelling the producers use. */
export function sessionEventWorkspaceId(properties: unknown): string | undefined {
  const info = eventInfo(properties)
  return nonEmpty(readString(info, "workspaceID")) ?? nonEmpty(readString(info, "workspaceId"))
}

/** The identity and list-ordering fields a session-list row projection reads off `info`. */
export type SessionEventSummary = {
  id: string
  title?: string
  parentID?: string
  updated?: number
  archived?: number
}

export function sessionEventSummary(properties: unknown): SessionEventSummary | undefined {
  const info = eventInfo(properties)
  const id = nonEmpty(readString(info, "id"))
  if (!id) return undefined
  const time = asRecord(info?.time)
  const title = readString(info, "title")
  const parentID = nonEmpty(readString(info, "parentID"))
  const updated = readFiniteNumber(time, "updated")
  const archived = readFiniteNumber(time, "archived")
  return {
    id,
    ...(title === undefined ? {} : { title }),
    ...(parentID === undefined ? {} : { parentID }),
    ...(updated === undefined ? {} : { updated }),
    ...(archived === undefined ? {} : { archived }),
  }
}

/**
 * The full row, for the consumers that store `info` AS a session.
 *
 * The predicate checks exactly the fields those consumers dereference without a
 * guard — `id` and `time.created`/`time.updated`, which decide row identity and
 * list ordering. An `info` that lacks them cannot be merged into or ordered
 * within the session cache, so it is not a row. Everything else (`title`,
 * `slug`, `version`, …) is compared defensively downstream and may be absent
 * from a partial update.
 */
export function sessionEventRow(properties: unknown): Session | undefined {
  return sessionRow(asRecord(properties)?.info)
}

/** The same check applied to an already-unwrapped `info`. */
export function sessionRow(info: unknown): Session | undefined {
  const row = asRecord(info)
  return isSessionRow(row) ? row : undefined
}

function isSessionRow(info: Record<string, unknown> | undefined): info is Record<string, unknown> & Session {
  if (!info) return false
  const time = asRecord(info.time)
  return typeof info.id === "string" && info.id.length > 0
    && typeof time?.created === "number"
    && typeof time.updated === "number"
}

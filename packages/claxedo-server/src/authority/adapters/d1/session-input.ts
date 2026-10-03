import { createRequireText } from "@claxedo/helpers"
import { publicApiErrorShape } from "@claxedo/helpers/api-error"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import type { WorkspaceVisibility } from "@claxedo/server-core/platform/auth/authority"
import { asRecord } from "@claxedo/server-core/platform/json/index"

export type CanonicalMessage = {
  id: string
  role: string
  ordinal: number
  dataJson: string
  authorActorId: string | null
  turnId: string | null
}

const MAX_SNAPSHOT_MESSAGES = 500
const MAX_MESSAGE_BYTES = 256 * 1024
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
const MAX_VISIBILITY_ROWS = 500

export class D1SessionAuthorityError extends ClaxedoError {
  constructor(
    code:
      "invalid_input" | "resource_conflict" | "registration_transition_denied" | "actor_authorization_denied",
    message: string,
  ) {
    super({
      code,
      message,
      ...publicApiErrorShape(code),
    })
  }
}

export function visibilityRows(input: WorkspaceVisibility[]) {
  if (!Array.isArray(input) || input.length > MAX_VISIBILITY_ROWS) {
    throw new D1SessionAuthorityError("invalid_input", `Session visibility accepts at most ${MAX_VISIBILITY_ROWS} rows`)
  }
  const seen = new Set<string>()
  return input.map((value) => {
    const sessionId = requireText(value.sessionId, "sessionId")
    if (seen.has(sessionId))
      throw new D1SessionAuthorityError("invalid_input", "Session visibility contains duplicate identifiers")
    seen.add(sessionId)
    return {
      sessionId,
      title: optionalText(value.title, "title", 2_000),
      createdAt: optionalTimestamp(value.createdAt, "createdAt"),
      updatedAt: optionalTimestamp(value.updatedAt, "updatedAt"),
    }
  })
}

export function canonicalMessages(input: unknown[]): CanonicalMessage[] {
  if (!Array.isArray(input) || input.length > MAX_SNAPSHOT_MESSAGES) {
    throw new D1SessionAuthorityError(
      "invalid_input",
      `Session snapshots accept at most ${MAX_SNAPSHOT_MESSAGES} messages`,
    )
  }
  const ids = new Set<string>()
  return input.map((message, ordinal) => {
    const row = asRecord(message)
    const info = asRecord(row?.info)
    const id = optionalText(
      typeof row?.id === "string" ? row.id : typeof info?.id === "string" ? info.id : undefined,
      "message.id",
    )
    const role = optionalText(
      typeof row?.role === "string" ? row.role : typeof info?.role === "string" ? info.role : undefined,
      "message.role",
      100,
    )
    if (!id || !role)
      throw new D1SessionAuthorityError("invalid_input", "Every session message requires a canonical id and role")
    if (ids.has(id))
      throw new D1SessionAuthorityError("invalid_input", "Session snapshots contain duplicate message identifiers")
    ids.add(id)
    let dataJson: string
    try {
      dataJson = JSON.stringify(message)
    } catch {
      throw new D1SessionAuthorityError("invalid_input", "Session message must be JSON serializable")
    }
    if (dataJson === undefined || byteLength(dataJson) > MAX_MESSAGE_BYTES) {
      throw new D1SessionAuthorityError("invalid_input", `Session message exceeds ${MAX_MESSAGE_BYTES} bytes`)
    }
    return {
      id,
      role,
      ordinal,
      dataJson,
      authorActorId: null,
      turnId: optionalText(row?.turnId, "message.turnId") ?? null,
    }
  })
}

export function optionalOrdinal(value: number | undefined) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new D1SessionAuthorityError("invalid_input", "maxEventOrdinal must be a non-negative safe integer")
  }
  return value
}

export function positiveFence(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new D1SessionAuthorityError("invalid_input", "fencingToken must be a positive safe integer")
  }
  return value
}

export function optionalTimestamp(value: number | undefined, name: string) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 0)
    throw new D1SessionAuthorityError("invalid_input", `${name} is invalid`)
  return value
}

export const { requireText, optionalText } = createRequireText((message) => new D1SessionAuthorityError("invalid_input", message))

export function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength
}

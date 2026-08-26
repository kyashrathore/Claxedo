/**
 * Session transfer: the Node migration path.
 *
 * Why this exists rather than in-place migration: on Node the SDK's V1
 * migrator resolves to a no-op that reports `{ status: "completed" }` without
 * moving anything (contract doc §6.2). Every shipped Claxedo deployment is
 * Node, so `migration.v1.status` cannot gate readiness and the real path is
 * offline export from the legacy release, then typed `session.import` here.
 *
 * The envelope is the same on both sides — the legacy CLI exporter writes
 * `{ info, messages }` and V2's `SessionTransferData` is
 * `{ info: SessionInfo; messages: SessionMessageInfo[] }` — so this module
 * only has to reconcile the inner `info` shape and, critically, decide who
 * owns archive state.
 *
 * Archive ownership is the subtle part. V2 exposes `time.archived` as a
 * readable field but has NO archive mutation, so Claxedo's session projection
 * stays authoritative (R5). If we imported `time.archived` into the SDK we
 * would create a second archive authority that nothing can write to and that
 * silently disagrees with Claxedo's. So the transformer STRIPS it and the
 * caller restores archive state from Claxedo's own ledger.
 */

/** A V1 session envelope as the legacy exporter writes it. */
export type LegacyTransferEnvelope = Readonly<{
  info: Readonly<{
    id: string
    projectID: string
    title?: string | null
    parentID?: string | null
    agent?: string | null
    model?: Readonly<{ id: string; providerID: string; variant?: string | null }> | null
    cost?: number
    tokens?: Readonly<{
      input?: number
      output?: number
      reasoning?: number
      cache?: Readonly<{ read?: number; write?: number }>
    }>
    location: Readonly<{ directory: string; workspaceID?: string | null }>
    subpath?: string | null
    time: Readonly<{ created: number; updated: number; archived?: number | null }>
    /** V1 carried a per-session tool list; V2's SessionInfo does not. */
    tools?: unknown
  }>
  messages: readonly unknown[]
}>

/** What `session.import` accepts, plus the archive fact we keep out of it. */
export type TransferResult = Readonly<{
  /** Payload for `client.sessions.import`, with archive state removed. */
  payload: Readonly<{ info: Record<string, unknown>; messages: readonly unknown[] }>
  /**
   * Archive timestamp lifted out of the envelope, for Claxedo's projection
   * ledger. `undefined` means the session was not archived.
   */
  archivedAt?: number
  /** Fields present in V1 that V2's SessionInfo cannot represent. */
  droppedFields: readonly string[]
}>

export class TransferSchemaError extends Error {
  readonly code = "opencode_transfer_schema"
  constructor(message: string) {
    super(message)
    this.name = "TransferSchemaError"
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new TransferSchemaError(`Transfer envelope is missing ${field}`)
  return value
}

/**
 * Convert one legacy envelope into an importable V2 payload.
 *
 * Deliberately total and pure: no database reads, no private table access. If
 * a field cannot be represented it is reported in `droppedFields` rather than
 * silently discarded, so Unit 6's semantic validation can assert on it.
 */
export function toV2Transfer(envelope: LegacyTransferEnvelope): TransferResult {
  const info = envelope.info
  const id = requireString(info.id, "info.id")
  const projectID = requireString(info.projectID, "info.projectID")
  const directory = requireString(info.location?.directory, "info.location.directory")

  // Number.isFinite, not typeof: NaN is a number, and a NaN timestamp would
  // import a session that sorts and expires unpredictably forever after.
  if (!Number.isFinite(info.time?.created) || !Number.isFinite(info.time?.updated)) {
    throw new TransferSchemaError(`Session ${id} has no usable created/updated timestamps`)
  }

  const dropped: string[] = []
  if (info.tools !== undefined && info.tools !== null) dropped.push("info.tools")

  const tokens = info.tokens ?? {}
  const payloadInfo: Record<string, unknown> = {
    id,
    projectID,
    location: {
      directory,
      ...(info.location.workspaceID ? { workspaceID: info.location.workspaceID } : {}),
    },
    cost: info.cost ?? 0,
    tokens: {
      input: tokens.input ?? 0,
      output: tokens.output ?? 0,
      reasoning: tokens.reasoning ?? 0,
      cache: { read: tokens.cache?.read ?? 0, write: tokens.cache?.write ?? 0 },
    },
    // Archive is intentionally absent — see the module note.
    time: { created: info.time.created, updated: info.time.updated },
    ...(info.title ? { title: info.title } : {}),
    ...(info.parentID ? { parentID: info.parentID } : {}),
    ...(info.agent ? { agent: info.agent } : {}),
    ...(info.subpath ? { subpath: info.subpath } : {}),
    ...(info.model
      ? {
          model: {
            id: info.model.id,
            providerID: info.model.providerID,
            ...(info.model.variant ? { variant: info.model.variant } : {}),
          },
        }
      : {}),
  }

  const archivedAt = Number.isFinite(info.time.archived) ? (info.time.archived as number) : undefined

  return {
    payload: { info: payloadInfo, messages: envelope.messages },
    ...(archivedAt === undefined ? {} : { archivedAt }),
    droppedFields: dropped,
  }
}

/** One session's expected post-import semantics, for validation. */
export type TransferExpectation = Readonly<{
  id: string
  parentID?: string
  title?: string
  messageCount: number
  archivedAt?: number
}>

export function expectationFor(envelope: LegacyTransferEnvelope): TransferExpectation {
  const transferred = toV2Transfer(envelope)
  return {
    id: envelope.info.id,
    ...(envelope.info.parentID ? { parentID: envelope.info.parentID } : {}),
    ...(envelope.info.title ? { title: envelope.info.title } : {}),
    messageCount: envelope.messages.length,
    ...(transferred.archivedAt === undefined ? {} : { archivedAt: transferred.archivedAt }),
  }
}

export type ValidationFailure = Readonly<{ id: string; field: string; expected: unknown; actual: unknown }>

/**
 * Compare what the SDK now holds against what the legacy export claimed.
 *
 * This is the readiness authority for the migration, precisely because
 * `migration.v1.status` lies on Node. A caller that cannot satisfy these
 * assertions must stay `unavailable` rather than admit traffic.
 */
export function validateImported(
  expected: TransferExpectation,
  actual: Readonly<{ id: string; parentID?: string; title?: string; messageCount: number }>,
): readonly ValidationFailure[] {
  const failures: ValidationFailure[] = []
  const check = (field: string, want: unknown, got: unknown) => {
    if (want !== got) failures.push({ id: expected.id, field, expected: want, actual: got })
  }
  check("id", expected.id, actual.id)
  check("parentID", expected.parentID, actual.parentID)
  check("title", expected.title, actual.title)
  check("messageCount", expected.messageCount, actual.messageCount)
  return failures
}

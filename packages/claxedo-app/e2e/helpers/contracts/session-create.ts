// CONTRACT BINDING: POST /session  (session creation)
//
// Second route bound to the real server, following the pattern established in
// `./session-prompt.ts` — read that file's header first for WHY this exists.
//
// WHAT IS DIFFERENT ABOUT THIS ROUTE
// ----------------------------------
// `prompt_async`'s contract is its body. This route's is mostly NOT: the app's
// `createSession` (`src/platform/runtime/agent/agent-runtime-client.ts:465-478`)
// sends `{ method: "POST", headers }` with **no body at all**. The enforceable
// surface here is therefore:
//
//   (a) the `x-claxedo-draft-id` HEADER, which the server validates against a strict
//       pattern and answers with a hard 400 on violation. The mock ignored it
//       entirely, so a client that ever produced an out-of-pattern draft id would
//       fail every real request while every mocked spec stayed green. This is the
//       highest-value half of this binding.
//   (b) the 201 status. The mock returned 200 (its shared `json()` helper defaults
//       there); the real route returns `c.json(normalizeSession(...), 201)` on every
//       success path.
//   (c) the body WHEN one is sent, which is looser than the route's own annotation
//       admits — see SESSION_CREATE_CONFIG_FIELDS.
//
// KNOWN LIMIT
// -----------
// The server's own validators (`parseDraftId`, `normalizeSessionConfigUpdate`) are
// module-private — neither is re-exported from `@claxedo/workspace-runtime/routes` or
// `/index`, so this module cannot CALL them and instead mirrors their rules with a
// source citation on each. If they are ever exported, delete the mirrors and call the
// real thing; that is strictly better than any copy.
import type { SessionConfigUpdate } from "@claxedo/agent-sdk-runtime"

// ---------------------------------------------------------------------------
// (a) The x-claxedo-draft-id header
// ---------------------------------------------------------------------------

/**
 * Mirrors `DRAFT_ID_PATTERN` at
 * `workspace-runtime/src/routes/session-core.ts:170`. A non-empty header that fails
 * this makes `parseDraftId` (same file, :172-182) throw
 * `HTTPException(400, "x-claxedo-draft-id must match [A-Za-z0-9][A-Za-z0-9_-]{0,127}")`
 * BEFORE the session is created — the create fails outright, it does not degrade.
 *
 * Absent or empty is legal and simply means "no draft id" (:173-175).
 */
export const DRAFT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export const DRAFT_ID_HEADER = "x-claxedo-draft-id"

// ---------------------------------------------------------------------------
// (c) The request body, when one is sent
// ---------------------------------------------------------------------------

type FieldSpec = {
  check: (value: unknown) => string | undefined
  /** What the server does with this field, quoted from the code that reads it. */
  consumedBy: string
}

function typeOf(value: unknown) {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function nullableString(name: string) {
  return (value: unknown) =>
    value === undefined || value === null || typeof value === "string"
      ? undefined
      : `${name} must be a string or null, got ${typeOf(value)}`
}

/**
 * The CONFIG half of the accepted body, bound to the real `SessionConfigUpdate`.
 *
 * The route annotates its body as `{ title?: string; model?: unknown }`
 * (`session-core.ts:447`) — that annotation UNDERSTATES what it consumes. The very
 * next line runs `normalizeSessionConfigUpdate(body)` (`session-config.ts:81-96`),
 * which reads `harness`, `runner` (legacy), `model`, `variant`, and `agent`. This
 * table binds to the normalizer's OUTPUT type so a new config field server-side
 * breaks the build here; `title` and legacy `runner` are handled separately below
 * because they are not part of `SessionConfigUpdate`.
 */
export const SESSION_CREATE_CONFIG_FIELDS = {
  harness: {
    check: (value) => {
      if (value === undefined) return undefined
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return `harness must be an object, got ${typeOf(value)}`
      }
      return undefined
    },
    consumedBy: "normalizeSessionHarness(row.harness ?? legacyRunner) — dropped entirely if it has no resolvable identity",
  },
  model: {
    check: (value) => {
      if (value === undefined || value === null) return undefined // null is meaningful: "clear the model"
      if (typeof value !== "object" || Array.isArray(value)) return `model must be an object or null, got ${typeOf(value)}`
      const model = value as Record<string, unknown>
      // promptModel (session-config.ts:70-79) returns undefined — silently dropping
      // the model — unless BOTH ids are strings. A half-filled model is not an error
      // server-side, it is a silent no-op, which is exactly the kind of thing a spec
      // should never be allowed to assert around.
      if (typeof model.providerID !== "string" || typeof model.modelID !== "string") {
        return `model must carry BOTH providerID and modelID as strings (promptModel drops it otherwise), got `
          + `providerID=${typeOf(model.providerID)} modelID=${typeOf(model.modelID)}`
      }
      return undefined
    },
    consumedBy: "promptModel(row.model); null clears, partial is silently dropped",
  },
  variant: {
    check: nullableString("variant"),
    consumedBy: 'kept only when `"variant" in row` and it is a string or null (session-config.ts:93)',
  },
  agent: {
    check: nullableString("agent"),
    consumedBy: 'kept only when `"agent" in row` and it is a string or null (session-config.ts:94)',
  },
} satisfies Record<keyof Required<SessionConfigUpdate>, FieldSpec>

/**
 * Non-config body fields the route legitimately accepts.
 * `title` is passed straight to `createSession(c, directory, body.title)`.
 * `runner` is the LEGACY harness shape (`{ type, model }`) that
 * `normalizeSessionConfigUpdate` still falls back to; kept so a spec exercising the
 * legacy path is not rejected here.
 */
export const SESSION_CREATE_EXTRA_FIELDS: Readonly<Record<string, FieldSpec>> = {
  title: {
    check: (value) =>
      value === undefined || typeof value === "string" ? undefined : `title must be a string, got ${typeOf(value)}`,
    consumedBy: "createSession(c, directory, body.title) — undefined means the adapter picks a default",
  },
  runner: {
    check: (value) => {
      if (value === undefined) return undefined
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return `runner must be an object, got ${typeOf(value)}`
      }
      return undefined
    },
    consumedBy: "LEGACY: read as `legacyRunner` only when `harness` is absent (session-config.ts:83-89)",
  },
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class SessionCreateContractError extends Error {
  constructor(url: string, problems: string[]) {
    super(
      `POST ${url} violated the real server's session-create contract `
        + `(workspace-runtime/src/routes/session-core.ts:445-490):\n  - ${problems.join("\n  - ")}\n`
        + `This is a REAL failure: the mock now enforces what the server enforces, so this `
        + `request would not have produced a session against a real backend.`,
    )
    this.name = "SessionCreateContractError"
  }
}

/**
 * Validates the draft-id header exactly as `parseDraftId` does. Returns the draft id
 * when present and valid, `undefined` when absent/empty.
 *
 * Throws on a malformed id rather than ignoring it — mirroring the server's 400, so a
 * spec cannot pass while sending an id the real server would reject.
 */
export function parseDraftIdHeader(headers: Readonly<Record<string, string>>, url: string): string | undefined {
  // Playwright lowercases header names in `request().headers()`, which matches the
  // literal the server reads (`c.req.header("x-claxedo-draft-id")`).
  const raw = headers[DRAFT_ID_HEADER]
  if (raw === undefined || raw.length === 0) return undefined
  if (!DRAFT_ID_PATTERN.test(raw)) {
    throw new SessionCreateContractError(url, [
      `${DRAFT_ID_HEADER}: ${JSON.stringify(raw)} does not match ${DRAFT_ID_PATTERN.source} — `
        + `the real server answers this with HTTP 400 and creates NO session `
        + `(parseDraftId, session-core.ts:176-180).`,
    ])
  }
  return raw
}

/**
 * Validates a session-create request body. The body is optional: the app's own
 * `createSession` sends none, and the server tolerates that via
 * `.catch(() => ({}))`, so absent/empty is valid and yields `{}`.
 */
export function parseSessionCreateRequest(rawBody: unknown, url: string): Record<string, unknown> {
  if (rawBody === undefined || rawBody === null) return {}
  if (typeof rawBody !== "object" || Array.isArray(rawBody)) {
    throw new SessionCreateContractError(url, [`body must be a JSON object when present, got ${typeOf(rawBody)}`])
  }

  const body = rawBody as Record<string, unknown>
  const problems: string[] = []
  const specs: Record<string, FieldSpec> = { ...SESSION_CREATE_CONFIG_FIELDS, ...SESSION_CREATE_EXTRA_FIELDS }

  for (const [field, spec] of Object.entries(specs)) {
    const problem = spec.check(body[field])
    if (problem) problems.push(problem)
  }

  for (const field of Object.keys(body)) {
    if (field in specs) continue
    problems.push(
      `unknown field "${field}" — neither the route nor normalizeSessionConfigUpdate reads it, `
        + `so the real server silently DROPS it. Add it to the server contract, stop sending it, `
        + `or document it here.`,
    )
  }

  if (problems.length > 0) throw new SessionCreateContractError(url, problems)
  return body
}

// ---------------------------------------------------------------------------
// (b) Response
// ---------------------------------------------------------------------------

/**
 * The real route returns **201**, not 200: `c.json(normalizeSession(session, directory), 201)`
 * (`session-core.ts:478`). The mock previously answered 200 via its default `json()`
 * status, so no spec could have caught a client that branched on the created-status.
 */
export const SESSION_CREATE_STATUS = 201

/**
 * Fields `normalizeSession` (`session-core.ts:202-223`) guarantees on the created
 * row. Asserted on the MOCK's own response so the fixture cannot drift into returning
 * a shape the real route never produces.
 */
export function assertSessionCreateResponse(row: unknown, url: string): void {
  const problems: string[] = []
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new SessionCreateContractError(url, [`response must be a session object, got ${typeOf(row)}`])
  }
  const session = row as Record<string, unknown>
  if (typeof session.id !== "string" || session.id.length === 0) problems.push("response.id must be a non-empty string")
  if (typeof session.directory !== "string") problems.push("response.directory must be a string")
  // `normalizeSession` returns early when `time` is already present, and otherwise
  // synthesises it — so every created row has one, and the app's timeline sorting
  // depends on it.
  const time = session.time
  if (!time || typeof time !== "object") problems.push("response.time must be an object ({created, updated})")
  else {
    const stamps = time as Record<string, unknown>
    if (typeof stamps.created !== "number") problems.push("response.time.created must be a number")
    if (typeof stamps.updated !== "number") problems.push("response.time.updated must be a number")
  }
  if (problems.length > 0) throw new SessionCreateContractError(url, problems)
}

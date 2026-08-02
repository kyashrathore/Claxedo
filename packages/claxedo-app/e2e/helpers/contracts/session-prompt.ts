// CONTRACT BINDING: POST /session/:id/prompt_async
//
// WHY THIS FILE EXISTS
// --------------------
// `e2e/helpers/mock-runtime.ts` intercepts 81 routes and imports exactly one thing:
// `type { Page, Route } from "@playwright/test"`. It shares NO types, schemas, or
// fixtures with the server that actually serves those routes. That means every
// payload assertion in the suite — `expect(mock.requests.promptBodies[0]?.text)` and
// friends — proves the client sent a shape THE MOCK accepts, not a shape the real
// server accepts. If `workspace-runtime` changes this route's contract tomorrow,
// ~289 `@core` tests stay green while the product is broken.
//
// This module closes that hole for ONE route, as the pattern for the other 80.
// It provides two independent layers:
//
//   (1) COMPILE-TIME DRIFT TRIPWIRE — `SESSION_PROMPT_FIELDS` below is declared
//       `satisfies Record<keyof Required<SessionPromptBody>, FieldSpec>` against the
//       REAL server type. If the server adds a field, this file is missing a key and
//       typecheck fails. If the server removes a field, this file has an excess key
//       and typecheck fails. Neither can land silently. (This only bites because e2e
//       is now actually typechecked: `tsconfig.e2e.json` existed but was referenced by
//       nothing — no `references`, no script, no CI — and reported 118 errors the
//       moment it was turned on. Those are cleared and `typecheck:e2e` is chained into
//       `bun run typecheck`; do not let that regress or this tripwire goes quiet.)
//
//   (2) RUNTIME VALIDATION — `parseSessionPromptRequest` rejects any request body the
//       real server's `prompt()` reducer could not consume, and
//       `sessionPromptResponse` pins the response the real route returns (204, empty
//       body). A spec that drives the client into sending a malformed prompt now
//       FAILS at the mock boundary with a legible message, instead of being quietly
//       accepted by a permissive fixture.
//
// EXTENDING THIS TO ANOTHER ROUTE
// -------------------------------
// Copy the three sections below: import the server's request type, declare the field
// table with `satisfies Record<keyof Required<T>, FieldSpec>`, write the validator.
// Do not hand-copy the server's field list into a local interface — that is exactly
// the drift this module exists to prevent.
//
// KNOWN LIMIT
// -----------
// The server does not runtime-validate this body either: `session-core.ts:720` does
// `(await c.req.json().catch(() => ({}))) as SessionPromptBody` — an unchecked cast.
// So this module pins the TYPE contract and the reducer's real consumption rules
// (`prompt()` in `workspace-runtime/src/session/service.ts:135-155`), not a shared
// zod schema, because no such schema exists yet. If one is ever added server-side,
// replace the validator body with `schema.parse()` and delete the hand-written
// checks — the field table stays as the compile-time tripwire either way.
import type { SessionPromptBody } from "@claxedo/workspace-runtime/routes"

// ---------------------------------------------------------------------------
// (1) Compile-time drift tripwire
// ---------------------------------------------------------------------------

type FieldSpec = {
  /** Runtime check. Receives the raw value; returns an error string, or undefined when valid. */
  check: (value: unknown) => string | undefined
  /**
   * What the server does with this field when it is absent — quoted from
   * `prompt()` in workspace-runtime/src/session/service.ts. Documents why an
   * optional field is genuinely optional rather than merely untested.
   */
  whenAbsent: string
}

function optionalString(name: string) {
  return (value: unknown) => (value === undefined || typeof value === "string" ? undefined : `${name} must be a string, got ${typeOf(value)}`)
}

function typeOf(value: unknown) {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

/**
 * Every field of the server's `SessionPromptBody`, with its runtime check.
 *
 * The `satisfies Record<keyof Required<SessionPromptBody>, FieldSpec>` clause is the
 * whole point: this object must have EXACTLY the server type's keys. Adding a field
 * server-side breaks the build here until it is validated; removing one breaks the
 * build here until it is deleted.
 */
export const SESSION_PROMPT_FIELDS = {
  parts: {
    check: (value) =>
      value === undefined || Array.isArray(value) ? undefined : `parts must be an array, got ${typeOf(value)}`,
    whenAbsent: "defaults to [] — an empty prompt the adapter still dispatches",
  },
  messageID: {
    check: optionalString("messageID"),
    whenAbsent: "server mints one via mkUserMessageId(); NOTE this also disables the route's idempotency dedup path",
  },
  agent: {
    check: optionalString("agent"),
    whenAbsent: 'falls back to session config, then the literal "build"',
  },
  model: {
    check: (value) => {
      if (value === undefined) return undefined
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return `model must be an object, got ${typeOf(value)}`
      }
      const model = value as Record<string, unknown>
      for (const key of ["providerID", "modelID"]) {
        if (model[key] !== undefined && typeof model[key] !== "string") {
          return `model.${key} must be a string, got ${typeOf(model[key])}`
        }
      }
      return undefined
    },
    whenAbsent: 'falls back to session config, then "anthropic"/"claude-sonnet-4-6"',
  },
  tools: {
    check: (value) => {
      if (value === undefined) return undefined
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return `tools must be an object, got ${typeOf(value)}`
      }
      for (const [key, enabled] of Object.entries(value as Record<string, unknown>)) {
        if (typeof enabled !== "boolean") return `tools.${key} must be a boolean, got ${typeOf(enabled)}`
      }
      return undefined
    },
    whenAbsent: "omitted from PromptInput entirely (adapter default tool set applies)",
  },
  format: {
    check: (value) => {
      if (value === undefined) return undefined
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return `format must be an object, got ${typeOf(value)}`
      }
      const type = (value as Record<string, unknown>).type
      return typeof type === "string" ? undefined : `format.type must be a string, got ${typeOf(type)}`
    },
    whenAbsent: "omitted from PromptInput entirely (no structured-output request)",
  },
  system: {
    check: optionalString("system"),
    whenAbsent: "omitted from PromptInput entirely (adapter/system default applies)",
  },
  variant: {
    check: optionalString("variant"),
    whenAbsent: "falls back to session config's variant, else omitted — note the server checks `!== undefined`, so an explicit variant of \"\" is meaningful and NOT the same as absent",
  },
  permissionMode: {
    check: optionalString("permissionMode"),
    whenAbsent:
      "the turn runs under whatever mode the harness already stands at — for a FIRST turn that is the runtime's default rung, since no session existed to set one on beforehand",
  },
} satisfies Record<keyof Required<SessionPromptBody>, FieldSpec>

/**
 * Fields the CLIENT posts that the server's `SessionPromptBody` has no slot for, and
 * therefore silently drops. Found by turning this validator on for the first time —
 * every one of them is over-posting, not a defect, so they are pinned here instead of
 * failing the suite.
 *
 * Root cause (single, shared): `agent-runtime-client.ts:599` dispatches with
 * `jsonInit("POST", input)` — it serializes the WHOLE client input object as the
 * request body, including the fields it only uses locally to build the URL. Any field
 * added to `AgentRuntimePromptPayload` will start being posted too.
 *
 * These are documented-benign, NOT approved-forever. If the server ever grows a real
 * field with one of these names, the type tripwire above fires first and this list
 * must be re-examined. Anything NOT listed here is still a hard failure.
 */
export const SESSION_PROMPT_CLIENT_ONLY_FIELDS: Readonly<Record<string, string>> = {
  sessionID:
    "redundant with the URL path param — the route reads `c.req.param(\"id\")` (session-core.ts:715), never the body",
  directory:
    "redundant with the `?directory=` query param — the route resolves it via `opts.resolveDirectory(c, …)` (session-core.ts:718), never the body",
  mode:
    "client-side TRANSPORT discriminator (\"sync\" | \"async\"), used only to pick the `/message` vs `/prompt_async` suffix (agent-runtime-client.ts:598). It is NOT the composer mode and the server reads `body.mode` nowhere in the prompt path — verified by grep across workspace-runtime/src and agent-sdk-runtime/src",
}

// ---------------------------------------------------------------------------
// (2) Runtime validation
// ---------------------------------------------------------------------------

export class SessionPromptContractError extends Error {
  constructor(url: string, problems: string[]) {
    super(
      `POST ${url} violated the real server's SessionPromptBody contract `
        + `(workspace-runtime/src/session/service.ts):\n  - ${problems.join("\n  - ")}\n`
        + `This is a REAL failure: the mock now enforces the same shape the server does, `
        + `so the client is sending something workspace-runtime could not consume.`,
    )
    this.name = "SessionPromptContractError"
  }
}

/**
 * Validates an intercepted `prompt_async` request body against the real server type
 * and returns it typed. Throws `SessionPromptContractError` listing every problem.
 *
 * `rawBody` is `Route.request().postDataJSON()`'s output — already JSON-parsed, so a
 * non-object here means the client sent a non-object JSON payload (the server would
 * cast it and then read `undefined` off every field, silently dispatching an empty
 * prompt — worth failing loudly on).
 */
export function parseSessionPromptRequest(rawBody: unknown, url: string): SessionPromptBody {
  const problems: string[] = []

  if (rawBody === undefined || rawBody === null) {
    // The server's `.catch(() => ({}))` tolerates an absent/unparseable body, so this
    // is legal — it just produces an empty prompt. Mirror that, do not throw.
    return {}
  }
  if (typeof rawBody !== "object" || Array.isArray(rawBody)) {
    throw new SessionPromptContractError(url, [`body must be a JSON object, got ${typeOf(rawBody)}`])
  }

  const body = rawBody as Record<string, unknown>

  for (const [field, spec] of Object.entries(SESSION_PROMPT_FIELDS)) {
    const problem = spec.check(body[field])
    if (problem) problems.push(problem)
  }

  // Unknown fields are a drift signal in the OTHER direction: the client is sending
  // something the server type has no slot for, so the server silently drops it. The
  // three already-known ones are pinned in SESSION_PROMPT_CLIENT_ONLY_FIELDS with
  // their reasons; anything NEW fails here, which is the point.
  const known = new Set(Object.keys(SESSION_PROMPT_FIELDS))
  for (const field of Object.keys(body)) {
    if (known.has(field) || field in SESSION_PROMPT_CLIENT_ONLY_FIELDS) continue
    problems.push(
      `unknown field "${field}" — the real server casts the body to SessionPromptBody `
        + `and would silently DROP it. Either add it to SessionPromptBody server-side, stop `
        + `sending it client-side, or (if it is deliberate over-posting like sessionID/`
        + `directory/mode) document it in SESSION_PROMPT_CLIENT_ONLY_FIELDS.`,
    )
  }

  if (problems.length > 0) throw new SessionPromptContractError(url, problems)
  return body as SessionPromptBody
}

// ---------------------------------------------------------------------------
// (3) Response + id conventions the real route guarantees
// ---------------------------------------------------------------------------

/**
 * The real route's success response, verbatim: `return c.body(null, 204)`
 * (workspace-runtime/src/routes/session-core.ts:714-796 — every success path, both
 * the dedup short-circuits and the fire-and-forget dispatch, returns exactly this).
 * The mock must not invent a 200-with-JSON here; specs that assert "the reply arrives
 * over SSE, not from this response" depend on it being empty.
 */
export const SESSION_PROMPT_SUCCESS = { status: 204, body: "" } as const

/**
 * `mkAssistantId` (workspace-runtime/src/session/service.ts:78-83): when the client
 * supplies a `messageID`, the assistant reply's id is EXACTLY `${messageID}_r`.
 *
 * This is not type-bindable today — `mkAssistantId` is module-private and not
 * re-exported from `@claxedo/workspace-runtime/routes` — so it is pinned here as a
 * function plus this comment. The app's REST reconciliation
 * (`assistantMessageIdForUserMessage`) matches on this exact id; a synthetic id in
 * the mock silently disables that entire recovery path for every spec that relies on
 * it. If the convention ever changes server-side, this is the single place to fix.
 */
export function assistantIdForUserMessage(userMessageId: string) {
  return `${userMessageId}_r`
}

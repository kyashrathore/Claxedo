// CONTRACT BINDING: POST /session/:id/command
// PLUS a NEGATIVE finding for POST /session/:id/shell (see section 4 — that route
// has no counterpart on the server the app actually talks to).
//
// Third route bound to the real server, following the pattern established in
// `./session-prompt.ts` — read that file's header first for WHY this exists.
//
// WHAT IS DIFFERENT ABOUT THIS ROUTE
// ----------------------------------
// `prompt_async` and `POST /session` both have a NAMED server type for their body
// (`SessionPromptBody`, `SessionConfigUpdate`). This one does not. The route reads its
// body through an anonymous inline cast:
//
//     const body = (await c.req.json().catch(() => ({}))) as { command?: string }
//     await adapter.executeCommand!(sessionId, body.command ?? "", directory)
//                                                 — session-core.ts:710-711
//
// So there is no `SessionCommandBody` to bind `satisfies` against, and this module does
// NOT pretend otherwise: the KEY SET below is hand-written from that cast and is only as
// current as its citation. What IS genuinely bound is the one thing the server does with
// the body — the second parameter of the adapter's `executeCommand`, reached structurally
// through the exported `createSessionRoutes` (section 1). If that parameter ever stops
// being a plain string, this file fails to compile.
//
// THE DIVERGENCE THIS ROUTE ALREADY HAS
// -------------------------------------
// The real route answers **HTTP 200 with `{"ok":true}`** (`return c.json({ ok: true })`,
// session-core.ts:712). The mock answered **204 with an empty body**
// (`route.fulfill({ status: 204, body: "" })`, mock-runtime.ts:1446). Both were read
// directly. Nothing in the app reads this response today —
// `dispatchSlashCommand` awaits and discards it (`src/features/session/submit/
// dispatch.ts:21-23`) — so no spec caught it, which is exactly the failure mode this
// binding series exists to close. `SESSION_COMMAND_SUCCESS` below pins the real one.
//
// A SECOND, LOUDER DIVERGENCE (client ↔ server, not mock ↔ server)
// ----------------------------------------------------------------
// The app posts far more than `command`. `dispatchCommandPromptSubmit`
// (`src/features/session/composer/ui/submit-command-prompt.ts:61-79`) hands the SDK
// `{ sessionID, directory, command, arguments, agent, model, variant, parts }`, and the
// v2 SDK's `session.command` splits those into path (`sessionID`), query (`directory`)
// and body (`messageID, agent, model, arguments, command, variant, parts`) —
// `packages/sdk/js/src/v2/gen/sdk.gen.ts:4168-4219`. workspace-runtime reads exactly ONE
// of the body fields. `arguments`, `agent`, `model`, `variant`, `parts` and `messageID`
// are received and dropped on the floor; the OpenCode adapter then re-posts only
// `{ command }` onward (`packages/agent-sdk-runtime/src/harnesses/opencode/index.ts:543-550`).
// Those are pinned in SESSION_COMMAND_CLIENT_ONLY_FIELDS rather than failed, because they
// are the status quo — but they are recorded as DROPPED, not as harmless over-posting.
//
// KNOWN LIMIT
// -----------
// As with the sibling modules, the server does not runtime-validate this body: the cast
// at session-core.ts:710 is unchecked and `body.command ?? ""` means a missing or
// non-string `command` becomes an empty command string rather than an error. This module
// therefore pins the CONSUMPTION rules, not a shared schema, because no shared schema
// exists. If one is ever added server-side, replace the validator body with
// `schema.parse()` and keep section 1 as the tripwire.
import type { createSessionRoutes } from "@claxedo/workspace-runtime/routes"

// ---------------------------------------------------------------------------
// (1) Compile-time drift tripwire
// ---------------------------------------------------------------------------

/**
 * The server's own adapter contract, reached structurally.
 *
 * `AgentHarnessAdapter` lives at `@claxedo/agent-sdk-runtime/adapters`
 * (imported by `session-core.ts:16`), but that SUBPATH is not resolvable from
 * `tsconfig.e2e.json` — its `paths` map only aliases the bare
 * `@claxedo/agent-sdk-runtime` specifier, and agent-sdk-runtime is not a direct
 * dependency of claxedo-app. Verified: importing the subpath directly fails with
 * `TS2307: Cannot find module '@claxedo/agent-sdk-runtime/adapters'`.
 *
 * Rather than hand-copy the signature (the exact drift this series exists to prevent),
 * the same type is pulled off `createSessionRoutes`, which IS exported from
 * `@claxedo/workspace-runtime/routes` (`workspace-runtime/src/routes.ts:40`). Its
 * options object declares `resolveAdapter` as returning `AgentHarnessAdapter`
 * (`session-core.ts:102-108`), so this chain lands on the real interface with no copy.
 */
type SessionRouteOpts = Parameters<typeof createSessionRoutes>[0]
type ServerAdapter = Awaited<ReturnType<SessionRouteOpts["resolveAdapter"]>>

/**
 * `executeCommand` is OPTIONAL on the adapter — it comes from
 * `Partial<SupportsCommands>` (`agent-sdk-runtime/src/adapter-contract.ts:85-87, 123`),
 * which is why the route reaches it as `adapter.executeCommand!` after
 * `unsupportedIfUnavailable` has proven it present (`session-core.ts:708, 711`).
 */
type ServerExecuteCommand = NonNullable<ServerAdapter["executeCommand"]>

/**
 * The type the server's `command` body field is ultimately funnelled into:
 * `executeCommand(id: string, command: string, directory: RuntimeDirectory)`
 * (`agent-sdk-runtime/src/adapter-contract.ts:86`), called as
 * `adapter.executeCommand!(sessionId, body.command ?? "", directory)`
 * (`session-core.ts:711`).
 */
export type ServerCommandArgument = Parameters<ServerExecuteCommand>[1]

/**
 * `true` only while `ServerCommandArgument` is EXACTLY `string` — not a subtype
 * (a string-literal union would fail the first branch) and not a supertype
 * (`any`/`unknown` fails the second). If the harness contract ever promotes the command
 * argument to a structured object, or narrows it to an enum of known commands, this
 * constant stops compiling and the validator below has to be rewritten rather than
 * silently continuing to accept free-form strings.
 */
type ExactlyString<T> = [T] extends [string] ? ([string] extends [T] ? true : never) : never
export const SESSION_COMMAND_ARGUMENT_IS_STRING: ExactlyString<ServerCommandArgument> = true

/**
 * The body shape the route casts to, mirroring `session-core.ts:710` verbatim.
 *
 * The KEY (`command`) is hand-written — there is no named server type to bind it to, and
 * this file says so in its header instead of faking a `satisfies` clause. The VALUE type
 * is bound: it is `ServerCommandArgument`, so it cannot drift.
 */
export type SessionCommandBody = { command?: ServerCommandArgument }

type FieldSpec = {
  /** Runtime check. Receives the raw value; returns an error string, or undefined when valid. */
  check: (value: unknown) => string | undefined
  /** What the server does with this field, quoted from the code that reads it. */
  consumedBy: string
}

function typeOf(value: unknown) {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

/**
 * The only field the real route reads.
 *
 * `satisfies Record<keyof Required<SessionCommandBody>, FieldSpec>` still buys the
 * excess/missing-key check against the local mirror above, so a future edit that adds a
 * key to `SessionCommandBody` without validating it will not compile. It does NOT buy
 * server drift detection the way `SESSION_PROMPT_FIELDS` does, because the mirror is
 * local. That is a real, stated weakness of this route, not a gap in this file.
 */
export const SESSION_COMMAND_FIELDS = {
  command: {
    check: (value) =>
      value === undefined || typeof value === "string"
        ? undefined
        : `command must be a string, got ${typeOf(value)}`,
    consumedBy:
      "adapter.executeCommand(sessionId, body.command ?? \"\", directory) (session-core.ts:711) — "
      + "NOTE the `?? \"\"`: an absent command is NOT an error server-side, it dispatches the "
      + "EMPTY command. A spec that asserts \"the command reached the harness\" cannot rely on "
      + "the response to tell it apart from a no-op.",
  },
} satisfies Record<keyof Required<SessionCommandBody>, FieldSpec>

/**
 * Body fields the CLIENT posts that the route never reads, so the real server receives
 * and DROPS them. Unlike the prompt route's client-only list — where the extra fields are
 * URL-building leftovers the server has no use for — several of these carry user intent
 * (`arguments` is the text typed after a slash command; `parts` are pasted images), so
 * "documented" here means "known to be lost", not "known to be benign".
 *
 * Source of every entry: the v2 SDK's `session.command` param map
 * (`packages/sdk/js/src/v2/gen/sdk.gen.ts:4168-4219`) marks each of these `{ in: "body" }` (:4198-4204),
 * and `submit-command-prompt.ts:61-79` populates all but `messageID`.
 *
 * `sessionID` and `directory` are deliberately NOT listed: the same SDK map places them
 * `{ in: "path" }` and `{ in: "query" }` respectively, so they never appear in the body at
 * all. If one ever shows up here, that is a real SDK change and should fail.
 *
 * These are documented-current, NOT approved-forever. Anything NOT listed here is a hard
 * failure.
 */
export const SESSION_COMMAND_CLIENT_ONLY_FIELDS: Readonly<Record<string, string>> = {
  arguments:
    "DROPPED. The slash command's argument text (submit-command-prompt.ts:67). The route reads only "
    + "`body.command`, and the OpenCode adapter re-posts `JSON.stringify({ command })` onward "
    + "(agent-sdk-runtime/src/harnesses/opencode/index.ts:548), so arguments never reach the harness.",
  agent:
    "DROPPED. Sent at submit-command-prompt.ts:68; no read of `body.agent` exists in the "
    + "/session/:id/command handler (session-core.ts:702-713).",
  model:
    "DROPPED. Sent as the string `${providerID}/${modelID}` (submit-command-prompt.ts:69) — note this "
    + "route's model encoding is a STRING, unlike prompt_async's `{ providerID, modelID }` object. "
    + "Unread either way.",
  variant:
    "DROPPED. Sent at submit-command-prompt.ts:70; unread by the route.",
  parts:
    "DROPPED. Image attachments, mapped to file parts at submit-command-prompt.ts:71-77; unread by the route.",
  messageID:
    "Not sent by the app today, but the SDK marks it `{ in: \"body\" }` (sdk.gen.ts:4198), so it is "
    + "reachable. It would also be DROPPED — unlike prompt_async, this route has no idempotency "
    + "dedup path keyed on messageID.",
}

// ---------------------------------------------------------------------------
// (2) Runtime validation
// ---------------------------------------------------------------------------

export class SessionCommandContractError extends Error {
  constructor(url: string, problems: string[]) {
    super(
      `POST ${url} violated the real server's /session/:id/command contract `
        + `(workspace-runtime/src/routes/session-core.ts:702-713):\n  - ${problems.join("\n  - ")}\n`
        + `This is a REAL failure: the mock now enforces the same shape the server consumes, `
        + `so the client is sending something workspace-runtime could not act on.`,
    )
    this.name = "SessionCommandContractError"
  }
}

/**
 * Validates an intercepted `/command` request body and returns it typed. Throws
 * `SessionCommandContractError` listing every problem.
 *
 * `rawBody` is `Route.request().postDataJSON()`'s output — already JSON-parsed.
 *
 * An absent body is legal: the server's `.catch(() => ({}))` tolerates it and then
 * dispatches the empty command via `?? ""` (session-core.ts:710-711). Mirror that, do not
 * throw — the mock must not be stricter than the server or specs fail for the wrong reason.
 */
export function parseSessionCommandRequest(rawBody: unknown, url: string): SessionCommandBody {
  if (rawBody === undefined || rawBody === null) return {}
  if (typeof rawBody !== "object" || Array.isArray(rawBody)) {
    throw new SessionCommandContractError(url, [`body must be a JSON object, got ${typeOf(rawBody)}`])
  }

  const body = rawBody as Record<string, unknown>
  const problems: string[] = []

  for (const [field, spec] of Object.entries(SESSION_COMMAND_FIELDS)) {
    const problem = spec.check(body[field])
    if (problem) problems.push(problem)
  }

  // Drift in the other direction: a field the server type has no slot for. The known
  // droppers are pinned above with their reasons; anything NEW fails here.
  const known = new Set(Object.keys(SESSION_COMMAND_FIELDS))
  for (const field of Object.keys(body)) {
    if (known.has(field) || field in SESSION_COMMAND_CLIENT_ONLY_FIELDS) continue
    problems.push(
      `unknown field "${field}" — the real route casts the body to \`{ command?: string }\` `
        + `(session-core.ts:710) and would silently DROP it. Either teach the server to read it, `
        + `stop sending it client-side, or document it in SESSION_COMMAND_CLIENT_ONLY_FIELDS.`,
    )
  }

  if (problems.length > 0) throw new SessionCommandContractError(url, problems)
  return body as SessionCommandBody
}

// ---------------------------------------------------------------------------
// (3) Response contract
// ---------------------------------------------------------------------------

/**
 * The real route's success body, verbatim: `return c.json({ ok: true })`
 * (`workspace-runtime/src/routes/session-core.ts:712`).
 */
export const SESSION_COMMAND_SUCCESS_BODY = { ok: true } as const

/**
 * **200**, not 204. `c.json(...)` with no explicit status is Hono's default 200; the
 * route passes none. The mock returned 204 with an empty body
 * (`mock-runtime.ts:1446`) — both sides read directly, this is the confirmed divergence.
 *
 * Worth keeping honest even though nothing branches on it today: the generated SDK the
 * app calls declares this route's 200 response as `{ info: AssistantMessage; parts: Part[] }`
 * (`packages/sdk/js/src/v2/gen/types.gen.ts:10454-10462`), i.e. the CLIENT's own types
 * expect a message payload that workspace-runtime does not produce. Any future code that
 * starts reading `session.command(...)`'s `data` would break against the real server, and
 * a 204-returning mock would hide it twice over.
 */
export const SESSION_COMMAND_SUCCESS_STATUS = 200

/** Spreadable into Playwright's `route.fulfill({ ...SESSION_COMMAND_SUCCESS })`. */
export const SESSION_COMMAND_SUCCESS = {
  status: SESSION_COMMAND_SUCCESS_STATUS,
  contentType: "application/json",
  body: JSON.stringify(SESSION_COMMAND_SUCCESS_BODY),
} as const

/**
 * The route's OTHER real outcome. Before touching the body it runs
 * `unsupportedIfUnavailable(c, adapter, directory, "commands", "executeCommand", "command")`
 * (`session-core.ts:708`), which answers **409** with
 * `{ ok: false, error: { code: "unsupported_operation", operation, capability, harness,
 * transport, reason, message } }` (`unsupportedOperation`, session-core.ts:311-333) when
 * either the harness does not advertise the `commands` capability (`caps[key]` falsy) or
 * the adapter does not provide the method (`typeof adapter[method] !== "function"`).
 * Note which branch actually fires for a given harness is not always the obvious one: the
 * Pi harness DOES define `executeCommand`, but only to `throw notImplemented("Commands")`
 * (`agent-sdk-runtime/src/harnesses/pi/index.ts:574-576`), so the `typeof` branch passes
 * and only the capability flag can produce the 409 there.
 *
 * The mock has no unsupported path at all, so no spec currently proves the app handles a
 * 409 here. Pinned so one can.
 */
export const SESSION_COMMAND_UNSUPPORTED_STATUS = 409

/**
 * Asserts the MOCK's own success response matches what the real route emits, so the
 * fixture cannot drift back into 204/empty.
 */
export function assertSessionCommandResponse(payload: unknown, url: string): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SessionCommandContractError(url, [
      `response must be the JSON object {"ok":true} (session-core.ts:712), got ${typeOf(payload)}`,
    ])
  }
  const body = payload as Record<string, unknown>
  if (body.ok !== true) {
    throw new SessionCommandContractError(url, [`response.ok must be literal true, got ${JSON.stringify(body.ok)}`])
  }
}

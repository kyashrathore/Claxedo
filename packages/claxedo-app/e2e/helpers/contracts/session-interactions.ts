// CONTRACT BINDING: the three human-in-the-loop interaction routes
//
//   POST /session/:sessionId/permissions/:permId   (session-core.ts:825-846)
//   POST /question/:id/reply                       (session-core.ts:847-870)
//   POST /question/:id/reject                      (session-core.ts:871-893)
//
// Third binding in this directory. Read `./session-prompt.ts`'s header first for WHY
// these exist at all — short version: `e2e/helpers/mock-runtime.ts` shares zero types
// with `workspace-runtime`, so a payload assertion proves the client matched the MOCK.
//
// NO NAMED SERVER TYPE EXISTS FOR THESE BODIES
// --------------------------------------------
// Unlike `prompt_async` (which casts to the exported `SessionPromptBody`), both of
// these routes cast to an ANONYMOUS INLINE type:
//
//   session-core.ts:833  `(await c.req.json().catch(() => ({}))) as { response?: string }`
//   session-core.ts:858  `(await c.req.json().catch(() => ({}))) as { answer?: string; answers?: string[][] }`
//
// There is nothing to `import type` and nothing to `satisfies`-bind the field tables
// against — grep for `response?: string` across `workspace-runtime/src` returns exactly
// that one line. So the field tables below are MIRRORS with citations, not tripwires,
// and this file does not pretend otherwise. If either inline cast is ever promoted to a
// named exported type, replace the mirrors with a `satisfies Record<keyof Required<T>, …>`
// clause the way `session-prompt.ts` does.
//
// What CAN be type-bound is the other end of the permission route: the decision the
// route computes and hands to the adapter is typed `PermissionDecision`
// (`agent-sdk-runtime/src/adapter-contract.ts:99`), re-exported as
// `AgentRuntimePermissionDecision` (`agent-sdk-runtime/src/runtime.ts:44`, exported at
// `agent-sdk-runtime/src/index.ts:15`). `PERMISSION_RESPONSE_DECISIONS` binds to it,
// and `PERMISSION_DECISION_UNION_PINNED` fails the build if that union ever changes.
//
// THE HAZARD THIS FILE PRIMARILY EXISTS FOR
// -----------------------------------------
// The permission route's mapping (session-core.ts:834-835) is a two-armed ternary with
// a catch-all else:
//
//   const r = body.response ?? "deny"
//   const decision = r === "once" ? "allow_once" : r === "always" ? "allow_always" : "deny"
//
// Only the two literals `"once"` and `"always"` are matched. EVERYTHING else — a typo
// (`"onces"`), a rename, a casing slip (`"Once"`), an absent body, an absent `response`
// key, a non-string value — lands in the else arm and becomes **deny**, with HTTP 200
// `{ ok: true }` (session-core.ts:845). The user clicks Allow, the tool call is denied,
// and nothing anywhere reports an error. `parseSessionPermissionRequest` below makes
// that case loud, because no other layer will.
import type { AgentRuntimePermissionDecision } from "@claxedo/agent-sdk-runtime"

function typeOf(value: unknown) {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

// ---------------------------------------------------------------------------
// (1) POST /session/:sessionId/permissions/:permId — the response vocabulary
// ---------------------------------------------------------------------------

/**
 * The wire values the server's mapping ACTUALLY recognises, pinned against
 * session-core.ts:834-835 and :843.
 *
 * There are three, and they are not symmetric:
 *
 *   "once"   — matched EXPLICITLY at :835 -> "allow_once".  Event reply: "once" (:843).
 *   "always" — matched EXPLICITLY at :835 -> "allow_always". Event reply: "always" (:843).
 *   "reject" — matched by NOTHING. It reaches "deny" through the else arm at :835 and
 *              "reject" through the else arm at :843. The outcome is the intended one,
 *              but only by coincidence of the default: it is indistinguishable from a
 *              garbage value. See PERMISSION_RESPONSE_IS_DEFAULT_ONLY.
 *
 * That "reject" is nonetheless the *intended* third token is confirmed independently of
 * this route: `permissionReplied`'s own parameter is typed
 * `reply: "once" | "always" | "reject"` (`agent-sdk-runtime/src/compat-events.ts:274`),
 * and the app's `answerPermission` declares the identical union
 * (`src/platform/runtime/agent/agent-runtime-client.ts:620`). Three files agree on the
 * vocabulary; only the route's implementation declines to check it.
 */
export const PERMISSION_RESPONSE_VALUES = ["once", "always", "reject"] as const

export type PermissionResponseValue = (typeof PERMISSION_RESPONSE_VALUES)[number]

/**
 * Which of the three tokens the route matches with an explicit `===` comparison, and
 * which merely fall into the default arm.
 *
 * This distinction is the whole reason the validator is strict about the exact string:
 * for "once"/"always" a typo degrades LOUDLY-ish (wrong decision, but a different one);
 * for "reject" there is no branch at all, so a typo produces a byte-for-byte identical
 * outcome to a correct reject — same `deny` decision, same `"reject"` event, same 200.
 * Nothing downstream can tell the two apart, which is why the check has to happen here.
 */
export const PERMISSION_RESPONSE_IS_DEFAULT_ONLY: Readonly<Record<PermissionResponseValue, boolean>> = {
  once: false,
  always: false,
  reject: true,
}

/**
 * Wire value -> the `PermissionDecision` the route hands to
 * `adapter.respondPermission(permId, decision, directory)` (session-core.ts:837;
 * adapter signature at `agent-sdk-runtime/src/adapter-contract.ts:99`).
 *
 * Bound to the real decision union so a server-side rename of any decision breaks this
 * file's build rather than silently invalidating every mocked permission assertion.
 */
export const PERMISSION_RESPONSE_DECISIONS = {
  once: "allow_once",
  always: "allow_always",
  reject: "deny",
} satisfies Record<PermissionResponseValue, AgentRuntimePermissionDecision>

type ExactUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/**
 * Compile-time tripwire on the decision union itself. If a decision is added, removed,
 * or renamed in `agent-sdk-runtime/src/runtime.ts:44`, this assignment stops being
 * `true` and typecheck fails here.
 *
 * It is pinned to FOUR members while `PERMISSION_RESPONSE_DECISIONS` can only ever
 * produce three — see PERMISSION_UNREACHABLE_DECISIONS.
 */
export const PERMISSION_DECISION_UNION_PINNED: ExactUnion<
  AgentRuntimePermissionDecision,
  "allow_once" | "allow_always" | "deny" | "reject_always"
> = true

/**
 * Decisions the adapter contract supports but this HTTP route can NEVER produce.
 *
 * `reject_always` is a first-class decision — `agent-sdk-runtime/src/adapter-contract.ts:35`
 * lists it, and the harnesses act on it distinctly (the Claude driver escalates it to an
 * interrupt: `agent-sdk-runtime/src/harnesses/claude/driver.ts:120`
 * `interrupt: decision === "reject_always"`). But session-core.ts:835 has no wire token
 * that reaches it: `"always"` is hard-wired to the ALLOW side. So "deny for the rest of
 * this session" is unreachable over HTTP.
 *
 * This is a capability gap, not a client bug — recorded here so a spec is never written
 * that assumes a mocked `reject_always` round-trips through the real route.
 */
export const PERMISSION_UNREACHABLE_DECISIONS = ["reject_always"] as const

export class SessionPermissionContractError extends Error {
  constructor(url: string, problems: string[]) {
    super(
      `POST ${url} violated the real server's permission-response contract `
        + `(workspace-runtime/src/routes/session-core.ts:825-846):\n  - ${problems.join("\n  - ")}\n`
        + `This is a REAL failure. The route matches ONLY the literals "once" and "always" `
        + `(:835); every other value — including an absent body — silently becomes the `
        + `"deny" decision and still answers HTTP 200 {"ok":true}. Against a real server this `
        + `request would deny the tool call with no error surfaced anywhere.`,
    )
    this.name = "SessionPermissionContractError"
  }
}

/**
 * Validates an intercepted permission-response body and returns the recognised wire
 * value.
 *
 * Deliberately STRICTER than the server: the server tolerates an absent body, an absent
 * `response`, and any string at all. It "tolerates" them by denying, which is precisely
 * the failure mode that must not be allowed to pass a test. Every rejection here
 * corresponds to a request that would produce a wrong-but-silent outcome in production.
 *
 * `rawBody` is `Route.request().postDataJSON()`'s output — already JSON-parsed. The app
 * always sends a body here (`agent-runtime-client.ts:630`:
 * `jsonInit("POST", { response: input.response })`), so `undefined` means the client
 * skipped it, which the server would read as deny.
 */
export function parseSessionPermissionRequest(rawBody: unknown, url: string): PermissionResponseValue {
  if (rawBody === undefined || rawBody === null) {
    throw new SessionPermissionContractError(url, [
      `no request body — the server's \`.catch(() => ({}))\` (:833) makes this parse to {}, `
        + `then \`body.response ?? "deny"\` (:834) DENIES the permission while returning 200.`,
    ])
  }
  if (typeof rawBody !== "object" || Array.isArray(rawBody)) {
    throw new SessionPermissionContractError(url, [
      `body must be a JSON object, got ${typeOf(rawBody)} — the server casts it to `
        + `{ response?: string } (:833), reads \`undefined\`, and denies.`,
    ])
  }

  const body = rawBody as Record<string, unknown>
  const problems: string[] = []
  const response = body.response

  if (response === undefined) {
    problems.push(
      `missing "response" — \`body.response ?? "deny"\` (:834) silently denies. `
        + `Send one of ${PERMISSION_RESPONSE_VALUES.map((v) => JSON.stringify(v)).join(", ")}.`,
    )
  } else if (typeof response !== "string") {
    problems.push(
      `response must be a string, got ${typeOf(response)} — a non-string fails both `
        + `\`=== "once"\` and \`=== "always"\` (:835) and lands in the deny arm.`,
    )
  } else if (!(PERMISSION_RESPONSE_VALUES as readonly string[]).includes(response)) {
    problems.push(
      `response ${JSON.stringify(response)} is not one of `
        + `${PERMISSION_RESPONSE_VALUES.map((v) => JSON.stringify(v)).join(", ")}. The server does `
        + `NOT reject it — the ternary at :835 falls through to "deny" and :843 publishes a `
        + `permission.replied event with reply "reject". If the user meant to ALLOW, the tool `
        + `call is denied and the UI is told a rejection happened, with no error anywhere. `
        + `Legacy/renamed tokens are the usual cause; the matching is exact and case-sensitive.`,
    )
  }

  // The body is cast, not parsed, so anything else is dropped on the floor server-side.
  for (const field of Object.keys(body)) {
    if (field === "response") continue
    problems.push(
      `unknown field "${field}" — the cast at :833 admits only "response", so the real server `
        + `silently DROPS this. Stop sending it, or widen the server's type first.`,
    )
  }

  if (problems.length > 0) throw new SessionPermissionContractError(url, problems)
  return response as PermissionResponseValue
}

// ---------------------------------------------------------------------------
// (2) POST /question/:id/reply
// ---------------------------------------------------------------------------

/**
 * `sessionId` is read from the QUERY STRING, not the body or the path:
 * `const sessionId = c.req.query("sessionId") ?? ""` (session-core.ts:848, and the
 * identical line at :872 for /reject). Its presence changes the route's behaviour in
 * three places, so it is not an optional convenience parameter:
 *
 *   PRESENT (truthy)
 *     :849-852  runs `sessionOperationGuard(opts, c, sessionId, "question_response")`,
 *               which can short-circuit the whole request.
 *     :854      SKIPS the `listQuestions` lookup entirely (`question` stays undefined).
 *     :855/:860 the adapter is resolved for, and the event published against, this id.
 *
 *   ABSENT (or empty string)
 *     :849      NO guard runs at all — the session-operation gate is bypassed.
 *     :854      the server scans `opts.listQuestions(c, directory)` for a row whose
 *               `id` matches the path param, to recover `question.sessionID`.
 *     :860      if that scan also misses, it falls back to
 *               `await questionSession(adapter, id, directory)`.
 *
 * The app sets it only when it has one — `if (input.sessionID) url.searchParams.set("sessionId", …)`
 * (`agent-runtime-client.ts:639`, and :652 for reject) — so BOTH branches are live in
 * production and a mock that ignores the query param exercises neither faithfully.
 */
export const QUESTION_SESSION_ID_QUERY_PARAM = "sessionId"

/**
 * Reads the `sessionId` query param the way the route does, returning `undefined` for
 * both "absent" and "empty string" because the server collapses them identically
 * (`?? ""` then a truthiness test at :849).
 *
 * Returns which server branch this request will take, so a spec can assert on it rather
 * than assume.
 */
export function parseQuestionSessionIdQuery(url: string): {
  sessionId: string | undefined
  /** true when the route will run `sessionOperationGuard`; false when it is bypassed (:849). */
  guarded: boolean
  /** true when the route will scan `listQuestions` to recover the session id (:854). */
  resolvesSessionByLookup: boolean
} {
  const raw = new URL(url, "http://mock.invalid").searchParams.get(QUESTION_SESSION_ID_QUERY_PARAM)
  const sessionId = raw === null || raw.length === 0 ? undefined : raw
  return {
    sessionId,
    guarded: sessionId !== undefined,
    resolvesSessionByLookup: sessionId === undefined,
  }
}

export class QuestionReplyContractError extends Error {
  constructor(url: string, problems: string[]) {
    super(
      `POST ${url} violated the real server's question-reply contract `
        + `(workspace-runtime/src/routes/session-core.ts:847-870):\n  - ${problems.join("\n  - ")}\n`
        + `This is a REAL failure: the mock now enforces what the server consumes, so this `
        + `request would not have answered the question against a real backend.`,
    )
    this.name = "QuestionReplyContractError"
  }
}

/**
 * Mirror of the inline body cast at session-core.ts:858 —
 * `{ answer?: string; answers?: string[][] }`. Not type-bound; see the header.
 */
export type QuestionReplyBody = { answer?: string; answers?: string[][] }

/**
 * Validates an intercepted `/question/:id/reply` body.
 *
 * TWO FIELDS, TWO DESTINATIONS — this is the subtle part. They are NOT alternatives:
 *
 *   :861  `adapter.replyQuestion!(id, body.answer ?? "", directory)`
 *           -> only `answer` ever reaches the harness.
 *   :867  `questionReplied(sid, id, body.answers ?? [[body.answer ?? ""]])`
 *           -> only `answers` (when present) reaches the UI event.
 *
 * So a body carrying `answers` but no `answer` tells the harness the empty string while
 * broadcasting the real selection to every SSE subscriber: the UI shows the question
 * answered correctly and the agent receives nothing. Both branches return 200. This
 * validator refuses that combination.
 *
 * A missing `answer` is likewise refused even though the server tolerates it — `?? ""`
 * at :861 means the agent is answered with an empty string, which no caller intends. An
 * `answer` that is explicitly `""` is allowed: a deliberate blank is a real user action
 * and is distinguishable from an omitted key.
 *
 * The app only ever sends `{ answer }` (`agent-runtime-client.ts:643`), so today the
 * `[[body.answer ?? ""]]` fallback at :867 is the live path and `answers` is unexercised
 * in production.
 */
export function parseQuestionReplyRequest(rawBody: unknown, url: string): QuestionReplyBody {
  if (rawBody === undefined || rawBody === null) {
    throw new QuestionReplyContractError(url, [
      `no request body — \`.catch(() => ({}))\` (:858) parses this to {}, and :861 then answers `
        + `the harness with the empty string while returning 200 {"ok":true}.`,
    ])
  }
  if (typeof rawBody !== "object" || Array.isArray(rawBody)) {
    throw new QuestionReplyContractError(url, [`body must be a JSON object, got ${typeOf(rawBody)}`])
  }

  const body = rawBody as Record<string, unknown>
  const problems: string[] = []

  if (body.answer === undefined) {
    problems.push(
      `missing "answer" — :861 sends \`body.answer ?? ""\` to the harness, so the question is `
        + `answered with an EMPTY STRING and the route still returns 200.`,
    )
  } else if (typeof body.answer !== "string") {
    problems.push(`answer must be a string, got ${typeOf(body.answer)} (cast at :858)`)
  }

  if (body.answers !== undefined) {
    if (!Array.isArray(body.answers)) {
      problems.push(`answers must be an array of string arrays, got ${typeOf(body.answers)}`)
    } else {
      for (const [index, group] of body.answers.entries()) {
        if (!Array.isArray(group)) {
          problems.push(`answers[${index}] must be an array of strings, got ${typeOf(group)}`)
          continue
        }
        for (const [inner, value] of (group as unknown[]).entries()) {
          if (typeof value !== "string") {
            problems.push(`answers[${index}][${inner}] must be a string, got ${typeOf(value)}`)
          }
        }
      }
      if (body.answer === undefined) {
        problems.push(
          `"answers" was sent without "answer" — the two fields go to DIFFERENT places: the `
            + `harness gets \`body.answer ?? ""\` (:861) and the SSE event gets \`body.answers\` (:867). `
            + `The UI would render the question as answered while the agent received "".`,
        )
      }
    }
  }

  for (const field of Object.keys(body)) {
    if (field === "answer" || field === "answers") continue
    problems.push(
      `unknown field "${field}" — the cast at :858 admits only "answer" and "answers"; anything `
        + `else is silently DROPPED by the real server.`,
    )
  }

  if (problems.length > 0) throw new QuestionReplyContractError(url, problems)
  return body as QuestionReplyBody
}

// ---------------------------------------------------------------------------
// (3) POST /question/:id/reject
// ---------------------------------------------------------------------------

export class QuestionRejectContractError extends Error {
  constructor(url: string, problems: string[]) {
    super(
      `POST ${url} violated the real server's question-reject contract `
        + `(workspace-runtime/src/routes/session-core.ts:871-893):\n  - ${problems.join("\n  - ")}\n`
        + `This is a REAL failure: the mock now enforces what the server consumes.`,
    )
    this.name = "QuestionRejectContractError"
  }
}

/**
 * Validates an intercepted `/question/:id/reject` request.
 *
 * This route reads NO body — there is no `c.req.json()` call anywhere between :871 and
 * :893. Everything it needs comes from the path param (`id`, :882) and the `sessionId`
 * query param (:872); the adapter call is `adapter.rejectQuestion!(id, directory)`
 * (:884) and the event is `questionRejected(sid, id)`
 * (`agent-sdk-runtime/src/compat-events.ts:298`), neither of which takes a payload.
 *
 * A body is therefore not "optional", it is provably inert: 100% of it is discarded. The
 * app correctly sends none — `init: { method: "POST" }` (`agent-runtime-client.ts:656`),
 * with no `jsonInit` — so any body arriving here means a caller believes it is
 * communicating something that never leaves the wire. That is failed loudly rather than
 * shrugged at.
 */
export function parseQuestionRejectRequest(rawBody: unknown, url: string): void {
  if (rawBody === undefined || rawBody === null) return
  if (typeof rawBody === "object" && !Array.isArray(rawBody) && Object.keys(rawBody as object).length === 0) return
  throw new QuestionRejectContractError(url, [
    `this route reads no body at all (nothing between :871 and :893 calls c.req.json()), so `
      + `${JSON.stringify(rawBody)} is discarded in full. If the caller needs to convey something `
      + `on a reject, the server has to grow a body first.`,
  ])
}

// ---------------------------------------------------------------------------
// (4) Responses — all three routes
// ---------------------------------------------------------------------------

/**
 * All three routes answer success with the SAME literal: `return c.json({ ok: true })`
 * (session-core.ts:845, :869, :893). Status is Hono's `c.json` default, 200 — not 204
 * like `prompt_async`, and not an echo of the decision. In particular the permission
 * route's 200 carries NO indication of which decision was computed, which is why a
 * mis-sent `response` value cannot be detected by the client from the response alone.
 */
export const SESSION_INTERACTION_SUCCESS = { status: 200, body: { ok: true } } as const

/**
 * The failure status these routes actually produce when the harness cannot service the
 * interaction: `unsupportedOperation` (session-core.ts:311-333) ends in `}, 409)`.
 *
 * The permission route reaches it via
 * `unsupportedIfUnavailable(c, adapter, directory, "permissions", "respondPermission", "permission_response")`
 * (:831) and the question routes via the same helper with `"questions"` / `"replyQuestion"`
 * (:856) and `"rejectQuestion"` (:880). `unsupportedIfUnavailable` (:355-372) fires when
 * either the capability flag is off OR the adapter lacks the method — so 409 is NOT a
 * "bad request", it is "this harness does not do this".
 */
export const SESSION_INTERACTION_UNSUPPORTED_STATUS = 409

/**
 * Shape of the 409 body (session-core.ts:322-333). Pinned so a mock cannot answer an
 * unsupported interaction with a bare status the app's error surface never learned to
 * read.
 */
export const SESSION_INTERACTION_UNSUPPORTED_ERROR_CODE = "unsupported_operation"

/**
 * Asserts a mocked success response matches what the real routes return, so the fixture
 * cannot drift into inventing a richer body (e.g. echoing the decision) that specs then
 * assert on and production never sends.
 */
export function assertInteractionOkResponse(body: unknown, url: string): void {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new QuestionReplyContractError(url, [`response must be the object {"ok":true}, got ${typeOf(body)}`])
  }
  const keys = Object.keys(body as object)
  const problems: string[] = []
  if ((body as Record<string, unknown>).ok !== true) problems.push(`response.ok must be exactly true`)
  for (const key of keys) {
    if (key === "ok") continue
    problems.push(
      `response field "${key}" — the real routes return the literal { ok: true } and nothing else `
        + `(:845, :869, :893). A spec asserting on this field would be asserting on the fixture.`,
    )
  }
  if (problems.length > 0) throw new QuestionReplyContractError(url, problems)
}

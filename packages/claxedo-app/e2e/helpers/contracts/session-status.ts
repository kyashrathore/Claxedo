// CONTRACT BINDING: GET /session/status
//
// Sixth route bound to the real server — read `./session-prompt.ts`'s header first for
// WHY this directory exists. This one is unusual: its entire contract is about what the
// response OMITS, and the mock had been getting that backwards.
//
// THE ROUTE
// ---------
// `workspace-runtime/src/routes/session-core.ts:466-472` is a thin shell —
// `c.json((await opts.getStatus?.(c, directory, adapter)) ?? {})`. The body therefore
// comes from whichever of the TWO `getStatus` implementations is wired:
//
//   (a) NO http-proxy adapter (ACP / SDK harnesses) — `routes/session.ts:176` returns
//       `sessionStatusSnapshot(await adapter.listSessions(directory))`
//       (`routes/session-status-snapshot.ts:11-23`). It walks the session rows and
//       keeps an entry ONLY when `live(row, ACP_RECOVER)`
//       (`agent-sdk-runtime/src/status.ts:34-46`) returns a value — i.e. only for rows
//       whose `status` is `busy`, `recovering`, or `retry`. Every other row hits
//       `if (!status) continue` and is absent from the map.
//
//   (b) http-proxy adapter (opencode) — `routes/session.ts:177-188` proxies the
//       response straight through from opencode's own `/session/status`, whose handler
//       is `Object.fromEntries(yield* statusSvc.list())`
//       (`opencode/src/server/routes/instance/httpapi/handlers/session.ts:81-82`) over
//       a Map that `SessionStatus.set` DELETES from the moment the incoming status is
//       idle (`opencode/src/session/status.ts:41-47`).
//
// Both paths therefore agree on the single rule that matters:
//
//   >>> AN IDLE SESSION HAS NO ENTRY. `{ ses_x: { type: "idle" } }` is a body neither
//   >>> server path can produce: idle is the ABSENCE of a key. Every client already
//   >>> reads it back that way — `statuses[target.sessionID] ?? { type: "idle" }`
//   >>> (rail-sidebar.tsx:920), `?? { type: "idle" as const }`
//   >>> (features/session/data/sync/queries.ts:387), and `!server || server.type ===
//   >>> "idle"` (session-store.ts:11, which collapses the two cases by hand).
//
// WHAT THE MOCK WAS DOING INSTEAD
// ------------------------------
// Two separate defects, and the second one hid the first:
//
//   1. `installMockRuntime`'s `**/session/status**` route answered a FIXED
//      `{ [SESSION_ID]: { type: "idle" } }` — one hardcoded id, in the one shape the
//      server cannot emit. A spec rendering rows from its own fixture ids had no way to
//      put any of them into a live state.
//   2. That route never ran. The mock's `**/session/*` catch-all is registered LAST and
//      Playwright matches most-recently-registered-first, so a GET of `/session/status`
//      — path-shaped exactly like `/session/:id` — was answered with a SESSION ROW.
//      Nothing failed loudly, because every consumer indexes the response by session id
//      and a session row has no such key: the garbage decoded as "everything idle".
//
// Between them, `core-sidebar-tree`'s behavior-4 status-dot scenario could not be
// written at all, and sat as `test.fixme` behind a note blaming a third thing.
//
// The fix for (1) is not "add more idle entries" — that doubles down on the impossible
// shape. It is to model what the server models: a map of LIVE sessions, keyed by id,
// that the mock mutates as the modelled sessions go busy and settle.
// `sessionStatusResponseBody` below is the only way the mock builds that body, so the
// "no idle entries" rule cannot be forgotten by the next caller. (2) is fixed by the
// catch-all handing `/session/status` back — see its comment in mock-runtime.ts.
//
// CONTRACT DIVERGENCES (deliberate, and the useful output of writing this file)
// ----------------------------------------------------------------------------
//   1. The mock does not (yet) publish its OWN modelled turn into this map: while
//      `installMockRuntime`'s streaming reply is mid-flight it emits `session.status
//      busy` over SSE but leaves the map empty for `SESSION_ID`, i.e. reports idle.
//      A real server would report `busy` for the same window. Specs that need to
//      observe busy state across a hydrate currently starve the route instead
//      (`neutralizeStatusPoll`, core-busy-abort-errors.spec.ts) — narrowing that
//      divergence would let them stop.
//   2. `retry` entries carry `attempt`/`message`/`next` server-side (status.ts:40-45).
//      Nothing in the app reads those three fields off this route — only `.type` — so
//      the builder validates them when present but does not synthesise them.
import type { StatusCompat } from "@claxedo/agent-sdk-runtime"

/**
 * A status that can actually appear as a VALUE in this route's map. Structurally
 * `StatusCompat` minus idle — see the rule above. Declared by subtraction rather than
 * re-listed so a new wire status added to `SessionStatusEvent.Info`
 * (`packages/schema/src/session-status-event.ts`) or to `StatusRecover`
 * (`agent-sdk-runtime/src/status.ts`) lands here automatically.
 */
export type LiveSessionStatus = Exclude<StatusCompat, { type: "idle" }>

/** The wire body: session id -> live status. Idle sessions are absent, never present-with-idle. */
export type SessionStatusResponse = Record<string, LiveSessionStatus>

type StatusSpec = {
  /** Does the real server keep an entry with this `type` in the map? */
  live: boolean
  /** The line that decides it, so a reader can re-verify without re-deriving. */
  decidedBy: string
}

/**
 * COMPILE-TIME DRIFT TRIPWIRE. `satisfies Record<StatusCompat["type"], StatusSpec>`
 * means adding a status type to the wire union server-side stops this file compiling
 * until someone records whether the new type survives into the status map. That is the
 * only decision this route makes, so it is the only one worth pinning.
 */
export const SESSION_STATUS_TYPES = {
  idle: {
    live: false,
    decidedBy: "opencode/src/session/status.ts:41-46 (`data.delete`); session-status-snapshot.ts:19 (`live()` returns undefined)",
  },
  busy: {
    live: true,
    decidedBy: "agent-sdk-runtime/src/status.ts:35 (`if (input.status === \"busy\") return { type: \"busy\" }`)",
  },
  retry: {
    live: true,
    decidedBy: "agent-sdk-runtime/src/status.ts:39-45 (rows that are not busy/recovering fall through to the retry branch)",
  },
  recovering: {
    live: true,
    decidedBy: "agent-sdk-runtime/src/status.ts:36-38 (`recovering(...)`)",
  },
} satisfies Record<StatusCompat["type"], StatusSpec>

export function isLiveSessionStatus(status: StatusCompat): status is LiveSessionStatus {
  return SESSION_STATUS_TYPES[status.type].live
}

function describe(value: unknown) {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

/**
 * Builds the route's response body from the mock's modelled session statuses.
 *
 * Two jobs, both enforcement rather than convenience:
 *   - DROPS idle entries, because the server cannot emit one (see the header). A caller
 *     that stores `{ type: "idle" }` gets absence, which is what the real server would
 *     have produced for that same session.
 *   - THROWS on a value that is not a recognised status. A silently-wrong status is the
 *     worst failure mode here: every consumer coerces an unreadable entry to idle, so
 *     the spec sees a green "idle" rather than an error, exactly the way the old fixed
 *     map made the sidebar's fixture rows permanently idle.
 */
export function sessionStatusResponseBody(entries: Record<string, StatusCompat>): SessionStatusResponse {
  const body: SessionStatusResponse = {}
  for (const [sessionId, status] of Object.entries(entries)) {
    if (!status || typeof status !== "object" || Array.isArray(status)) {
      throw new Error(`GET /session/status fixture: ${sessionId} status must be an object, got ${describe(status)}`)
    }
    const type = (status as { type?: unknown }).type
    if (typeof type !== "string" || !(type in SESSION_STATUS_TYPES)) {
      throw new Error(
        `GET /session/status fixture: ${sessionId} has unknown status type ${JSON.stringify(type)}; ` +
          `the wire union is ${Object.keys(SESSION_STATUS_TYPES).join(" | ")}`,
      )
    }
    if (type === "retry") {
      const retry = status as Extract<StatusCompat, { type: "retry" }>
      if (typeof retry.attempt !== "number" || typeof retry.message !== "string" || typeof retry.next !== "number") {
        throw new Error(
          `GET /session/status fixture: ${sessionId} retry status needs {attempt:number, message:string, next:number} ` +
            `(agent-sdk-runtime/src/status.ts:40-45)`,
        )
      }
    }
    if (!isLiveSessionStatus(status)) continue
    body[sessionId] = status
  }
  return body
}

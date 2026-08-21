// CONTRACT BINDING: POST + GET /api/claxedo/agent-config/harness
//
// Third route bound to the real server, following the pattern established in
// `./session-prompt.ts` — read that file's header first for WHY this exists.
//
// WHAT IS DIFFERENT ABOUT THIS ROUTE
// ----------------------------------
// The first two bindings target `workspace-runtime`. This one does NOT: the harness
// config surface is owned by **claxedo-server**, mounted at `/api/claxedo/agent-config`
// (`claxedo-server/src/deployments/local/server.ts:550`) and defined in
// `claxedo-local-server/src/agent-config/routes/index.ts:18` → `agentConfigHarnessRoutes(options)`.
// The handlers live in `claxedo-local-server/src/agent-config/routes/harness-routes.ts`:
//
//   `.get("/harness",  …)` → `harnessStatusResponse`  (:41, body at :48-143)
//   `.post("/harness", …)` → `updateHarnessResponse`  (:42, body at :145-212)
//
// (The sibling `.post("/harness/model")` :43 and `.get("/harness/options")` :44 are
// DIFFERENT contracts and are deliberately out of scope here — the mock routes
// `/harness/options` separately at `mock-runtime.ts:1260` and the exact-pathname guard
// at `mock-runtime.ts:1282` keeps `/harness/model` out of the handler this file binds.)
//
// THERE IS NO NAMED REQUEST TYPE — AND THIS FILE SAYS SO INSTEAD OF INVENTING ONE
// ------------------------------------------------------------------------------
// `updateHarnessResponse` types its body with an INLINE anonymous type argument:
//
//     const body = await c.req.json<{
//       harness?: unknown; id?: string; access?: string; type?: string
//       binary?: string; sessionId?: string; directory?: string; workspaceId?: string
//     }>().catch(() => null)                       — agent-config-harness-routes.ts:153-162
//
// No exported interface, no zod schema, nothing importable. Per the rules of this
// pattern, a local mirror of that literal would be a fabricated type, so this module
// does NOT declare one. Instead it binds the three REAL artifacts that actually decide
// whether a body is accepted, so drift in any of them breaks the build here:
//
//   (1) `HARNESS_IDENTITY_FIELDS` is `satisfies Record<keyof Required<HarnessIdentityInput>,
//       FieldSpec>` where `HarnessIdentityInput = NonNullable<Parameters<typeof
//       harnessFromRequest>[1]>` — the real second parameter of `harnessFromRequest`
//       (`claxedo-local-server/src/agent-config/harness.ts:53`), which is the function
//       the route hands the body to. Add a field to that parameter server-side and this
//       table is missing a key; remove one and it has an excess key.
//   (2) `HARNESS_RESULT_FIELDS` is `satisfies Record<keyof Required<SessionHarness>,
//       FieldSpec>` — the real `SessionHarness` (`agent-sdk-runtime/src/index.ts:137-141`),
//       i.e. what an accepted body must RESOLVE to and what the GET response carries.
//   (3) The `type` vocabulary is not mirrored at all: the validator CALLS the real
//       `normalizeHarnessIdentity` (`agent-sdk-runtime/src/harness-types.ts:108-123`),
//       which is exported and importable, so the accepted-id set can never drift out of
//       sync with a hand-copied list. This is strictly better than any mirror and is the
//       approach `./session-create.ts`'s header wishes it could have used.
//
// The four fields that exist ONLY at the top level (`harness`, `sessionId`, `directory`,
// `workspaceId`) genuinely have no type to bind to — they are read off the inline
// literal. They live in `HARNESS_POST_TOP_LEVEL_FIELDS` below with a source citation
// each, and that gap is disclosed rather than papered over.
// RUNTIME import, so it must be a real resolvable path — NOT the bare
// `@claxedo/agent-sdk-runtime` specifier. That package is not a dependency of
// claxedo-app; it resolves for TYPES only, via the `paths` alias in
// tsconfig.e2e.json. Playwright does not read tsconfig paths, so a bare specifier
// here typechecks fine and then dies at run time with
// "Cannot find package '@claxedo/agent-sdk-runtime'" — taking every spec in the
// suite with it, since mock-runtime imports this module.
//
// `harness-types.ts` has ZERO imports of its own, so reaching it directly by relative
// path pulls in no graph. Same convention as the claxedo-server reach below.
import { harnessKey, normalizeHarnessIdentity } from "../../../../agent-sdk-runtime/src/harness-types"
import type { AgentHarnessAccess, SessionHarnessId } from "../../../../agent-sdk-runtime/src/harness-types"
// Type-only, so the bare specifier is safe here — it erases before run time.
import type { SessionHarness } from "@claxedo/agent-sdk-runtime"
// Type-only reach into claxedo-server source. `e2e/` already imports that package by
// relative path in several helpers (`e2e/helpers/real-workgraph-harness.ts:25`,
// `e2e/helpers/workgraph-connection-browser-use-server.ts:7`), and `tsconfig.e2e.json`
// carries the `types: ["bun", …]` entry that exists specifically so those imports
// resolve — so this costs nothing at runtime and adds no new build surface.
import type { harnessFromRequest } from "../../../../claxedo-local-server/src/agent-config/harness"

// ---------------------------------------------------------------------------
// (1) Compile-time drift tripwires
// ---------------------------------------------------------------------------

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

function optionalString(name: string) {
  return (value: unknown) =>
    value === undefined || typeof value === "string" ? undefined : `${name} must be a string, got ${typeOf(value)}`
}

/**
 * The identity half of the request, bound to the REAL fallback parameter of
 * `harnessFromRequest` (`agent-config-harness.ts:53`). The route builds that argument
 * from the body at `agent-config-harness-routes.ts:164-169`.
 *
 * NOTE the asymmetry this table exists to make visible: `harnessFromRequest` reads
 * `transport`, `url` and `headers` off `row` (:60-62), where `row` is `input` (the
 * NESTED `body.harness` object) when that is a non-array object, and the `fallback`
 * otherwise (:56-58). The route's fallback only ever forwards `{id, access, type,
 * binary}` (:165-168) — so `transport`/`url`/`headers` sent at the TOP level of the
 * body are silently dropped, and only reach the server inside `body.harness`.
 */
export const HARNESS_IDENTITY_FIELDS = {
  type: {
    check: optionalString("type"),
    consumedBy:
      "legacy/alias harness key; fed to normalizeHarnessIdentity, which reads `row.id ?? row.type` (harness-types.ts:116)",
  },
  id: {
    check: optionalString("id"),
    consumedBy: "preferred over `type` by normalizeHarnessIdentity (harness-types.ts:116)",
  },
  access: {
    check: optionalString("access"),
    consumedBy:
      'defaults to "native" when an id resolves but no valid access is given (harness-types.ts:120); an unrecognised access is DROPPED, not rejected',
  },
  binary: {
    check: optionalString("binary"),
    consumedBy:
      "becomes `connection: { kind: \"process\", binary }` (agent-config-harness.ts:66-67) and participates in `sameHarness` (:47-51), so a binary change alone can trip the 409 lock",
  },
  transport: {
    check: (value) =>
      value === undefined || typeof value === "string"
        ? undefined
        : `transport must be a string, got ${typeOf(value)}`,
    consumedBy:
      'normalizeAgentHarnessTransport (harness-types.ts:98-102) — accepts "stdio" | "websocket" | "http" | "streamable-http" and silently returns undefined for anything else. TOP-LEVEL ONLY REACHES THE SERVER INSIDE `body.harness`.',
  },
  url: {
    check: optionalString("url"),
    consumedBy:
      'becomes `connection: { kind: "remote", url }` (agent-config-harness.ts:69-76). TOP-LEVEL ONLY REACHES THE SERVER INSIDE `body.harness`.',
  },
  headers: {
    check: (value) => {
      if (value === undefined) return undefined
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return `headers must be an object, got ${typeOf(value)}`
      }
      // `stringRecord` (agent-config-harness.ts:113-118) requires EVERY value to be a
      // string and otherwise drops the whole record — a partial-object header map is a
      // silent no-op server-side, not an error, which is exactly the kind of thing a
      // spec must never be allowed to assert around.
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (typeof item !== "string") {
          return `headers.${key} must be a string — stringRecord drops the ENTIRE headers object otherwise, got ${typeOf(item)}`
        }
      }
      return undefined
    },
    consumedBy:
      'becomes `connection: { kind: "remote", headers }` (agent-config-harness.ts:69-76). TOP-LEVEL ONLY REACHES THE SERVER INSIDE `body.harness`.',
  },
} satisfies Record<keyof Required<NonNullable<Parameters<typeof harnessFromRequest>[1]>>, FieldSpec>

/**
 * The subset of `HARNESS_IDENTITY_FIELDS` the ROUTE actually forwards from the top
 * level of the body — `harnessFromRequest(body.harness, { id, access, type, binary })`
 * (`agent-config-harness-routes.ts:164-169`). Anything outside this set must be nested
 * under `harness` to have any effect.
 */
export const HARNESS_POST_FORWARDED_IDENTITY_KEYS = ["id", "access", "type", "binary"] as const

/**
 * Fields that exist ONLY on the route's inline body literal
 * (`agent-config-harness-routes.ts:153-162`). There is no server-side named type for
 * these, so each carries its reading site instead of a `satisfies` clause. This is the
 * documented gap in this module's tripwire coverage.
 */
export const HARNESS_POST_TOP_LEVEL_FIELDS: Readonly<Record<string, FieldSpec>> = {
  harness: {
    check: (value) => {
      if (value === undefined) return undefined
      // `harnessFromRequest` passes `input ?? fallback` to normalizeHarnessIdentity
      // (agent-config-harness.ts:54), which accepts a STRING as well as an object
      // (harness-types.ts:109-113) — so `harness: "claude-acp"` is legal here.
      if (typeof value === "string") return undefined
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return `harness must be an object or a string, got ${typeOf(value)}`
      }
      const row = value as Record<string, unknown>
      for (const [field, spec] of Object.entries(HARNESS_IDENTITY_FIELDS)) {
        const problem = spec.check(row[field])
        if (problem) return `harness.${problem}`
      }
      return undefined
    },
    consumedBy: "the FULL identity input; wins over the flat id/access/type/binary fallback (agent-config-harness.ts:54-58)",
  },
  sessionId: {
    check: optionalString("sessionId"),
    consumedBy:
      "selects the per-session branch (agent-config-harness-routes.ts:175-203): with a resolvable workspace it writes setSessionHarness and NEVER touches the user config; without one it falls through to the global save (:205-208). Also readable from `?sessionId=` or the `x-session-id` header (:172).",
  },
  directory: {
    check: optionalString("directory"),
    consumedBy:
      "workspace resolution with `create: !!directory` (agent-config-harness-routes.ts:176-180) — absent directory means no workspace is auto-created. Also readable from `?directory=` or `x-opencode-directory` (:173).",
  },
  workspaceId: {
    check: optionalString("workspaceId"),
    consumedBy:
      "workspace resolution (agent-config-harness-routes.ts:174). The app's client NEVER sends this — `postHarnessConfig` posts only `{type, binary?, sessionId?, directory?}` (claxedo-app/src/features/session/harness/harness-switcher.ts:165-170) — so it is an untested server path.",
  },
}

/**
 * What an accepted body must RESOLVE to, bound to the real `SessionHarness`
 * (`agent-sdk-runtime/src/index.ts:137-141`). This is also the shape the GET response
 * spreads at its top level and repeats under `harness` / `activeHarness`
 * (`agent-config-harness-routes.ts:69-73`, `:102-118`).
 *
 * A new field on `SessionHarness` breaks this table until it is described; that matters
 * because the mock's GET fixture (`mock-runtime.ts:1300-1303`) emits NONE of these keys
 * — see `HARNESS_CONTRACT_DIVERGENCES` below.
 */
export const HARNESS_RESULT_FIELDS = {
  id: {
    check: (value) => (typeof value === "string" ? undefined : `id must be a string, got ${typeOf(value)}`),
    consumedBy: 'the BASE harness id ("claude" | "codex" | "cursor" | "opencode" | "pi"), NOT the access-qualified key',
  },
  access: {
    check: (value) =>
      value === "acp" || value === "native" ? undefined : `access must be "acp" | "native", got ${JSON.stringify(value)}`,
    consumedBy: "AGENT_HARNESS_ACCESSES (harness-types.ts:69)",
  },
  connection: {
    check: (value) => {
      if (value === undefined) return undefined
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return `connection must be an object, got ${typeOf(value)}`
      }
      const kind = (value as Record<string, unknown>).kind
      return kind === "process" || kind === "remote"
        ? undefined
        : `connection.kind must be "process" | "remote", got ${JSON.stringify(kind)}`
    },
    consumedBy: "harnessBinary() reads it only when kind === \"process\" (agent-config-harness.ts:43-45)",
  },
} satisfies Record<keyof Required<SessionHarness>, FieldSpec>

// ---------------------------------------------------------------------------
// (2) Runtime validation
// ---------------------------------------------------------------------------

export class HarnessConfigContractError extends Error {
  constructor(method: "POST" | "GET", url: string, problems: string[]) {
    super(
      `${method} ${url} violated the real server's harness-config contract `
        + `(claxedo-local-server/src/agent-config/routes/harness-routes.ts):\n  - ${problems.join("\n  - ")}\n`
        + `This is a REAL failure: the mock now enforces what claxedo-server enforces, so this `
        + `request/response would not have behaved this way against a real backend.`,
    )
    this.name = "HarnessConfigContractError"
  }
}

/** What the server resolves a POST body down to, plus the routing fields it reads alongside. */
export type ParsedHarnessConfigRequest = {
  /** Resolved via the REAL `normalizeHarnessIdentity`, so this can never drift from the server. */
  identity: { id: SessionHarnessId; access: AgentHarnessAccess }
  /**
   * The canonical, access-qualified key the server echoes as `activeType` on the next
   * GET (`harnessKey(saved) ?? …`, agent-config-harness-routes.ts:117). This is NOT
   * always the string the client posted — see `HARNESS_CONTRACT_DIVERGENCES.legacyKeyEcho`.
   */
  activeType: string
  binary?: string
  sessionId?: string
  directory?: string
  workspaceId?: string
}

/**
 * Validates an intercepted `POST /api/claxedo/agent-config/harness` body against the
 * real server's acceptance rules and returns what the server would resolve it to.
 * Throws `HarnessConfigContractError` listing every problem.
 *
 * `rawBody` is `Route.request().postDataJSON()`'s output — already JSON-parsed.
 *
 * Unlike the prompt route, an absent/unparseable body is NOT tolerated here: the route
 * does `.catch(() => null)` and then `if (!body || !next) return c.json(errorBody(
 * "agent_config_harness_required", …), 400)` (`agent-config-harness-routes.ts:162`,
 * `:171`). A missing body is a hard 400, so this throws rather than returning `{}`.
 */
export function parseHarnessConfigRequest(rawBody: unknown, url: string): ParsedHarnessConfigRequest {
  const fail = (problems: string[]): never => {
    throw new HarnessConfigContractError("POST", url, problems)
  }

  if (rawBody === undefined || rawBody === null) {
    return fail([
      "body is absent — the real server answers this with HTTP 400 "
        + `${JSON.stringify(HARNESS_POST_MISSING_HARNESS.code)} and changes NOTHING `
        + "(agent-config-harness-routes.ts:162,171).",
    ])
  }
  if (typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return fail([`body must be a JSON object, got ${typeOf(rawBody)}`])
  }

  const body = rawBody as Record<string, unknown>
  const problems: string[] = []

  const forwarded = new Set<string>(HARNESS_POST_FORWARDED_IDENTITY_KEYS)
  for (const [field, spec] of Object.entries(HARNESS_IDENTITY_FIELDS)) {
    if (!forwarded.has(field)) {
      // transport/url/headers at the TOP level never reach harnessFromRequest's `row`
      // (agent-config-harness-routes.ts:165-168 forwards only four keys), so sending
      // them flat is silent data loss, not a shape error. Flag it as such.
      if (body[field] !== undefined) {
        problems.push(
          `"${field}" was sent at the TOP level, where the route does not forward it — `
            + `it is silently DROPPED. Nest it under "harness" instead `
            + `(agent-config-harness-routes.ts:164-169).`,
        )
      }
      continue
    }
    const problem = spec.check(body[field])
    if (problem) problems.push(problem)
  }

  for (const [field, spec] of Object.entries(HARNESS_POST_TOP_LEVEL_FIELDS)) {
    const problem = spec.check(body[field])
    if (problem) problems.push(problem)
  }

  const known = new Set([...Object.keys(HARNESS_IDENTITY_FIELDS), ...Object.keys(HARNESS_POST_TOP_LEVEL_FIELDS)])
  for (const field of Object.keys(body)) {
    if (known.has(field)) continue
    problems.push(
      `unknown field "${field}" — the route's body literal `
        + `(agent-config-harness-routes.ts:153-162) has no slot for it, so the real server `
        + `silently DROPS it. Add it server-side, stop sending it, or document it here.`,
    )
  }

  if (problems.length > 0) fail(problems)

  // Call the REAL resolver rather than mirroring its id table. `harnessFromRequest`
  // does `normalizeHarnessIdentity(input ?? fallback)` (agent-config-harness.ts:54),
  // where `input` is `body.harness`; reproduce exactly that precedence.
  const identity = normalizeHarnessIdentity(
    body.harness ?? {
      id: body.id,
      access: body.access,
      type: body.type,
      binary: body.binary,
    },
  )
  if (!identity) {
    return fail([
      `no harness identity resolves from ${JSON.stringify({ harness: body.harness, id: body.id, type: body.type, access: body.access })} — `
        + `normalizeHarnessIdentity (harness-types.ts:108-123) returned undefined, so the real server `
        + `answers HTTP ${HARNESS_POST_MISSING_HARNESS.status} ${JSON.stringify(HARNESS_POST_MISSING_HARNESS.code)} `
        + `and changes NOTHING (agent-config-harness-routes.ts:171).`,
    ])
  }

  // `harnessKey` is likewise the real function (harness-types.ts:104-106); it returns
  // undefined only for an identity with no definition row, which cannot happen for a
  // value normalizeHarnessIdentity just produced.
  const activeType = harnessKey(identity) ?? identity.id

  return {
    identity,
    activeType,
    ...(typeof body.binary === "string" ? { binary: body.binary } : {}),
    ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
    ...(typeof body.directory === "string" ? { directory: body.directory } : {}),
    ...(typeof body.workspaceId === "string" ? { workspaceId: body.workspaceId } : {}),
  }
}

// ---------------------------------------------------------------------------
// (3) Responses the real route guarantees
// ---------------------------------------------------------------------------

/**
 * The POST success response, verbatim. BOTH success paths — the per-session write
 * (`setSessionHarness(…); return c.json({ ok: true })`,
 * `agent-config-harness-routes.ts:201-202`) and the global config write
 * (`await saveUserConfig(config); … return c.json({ ok: true })`, `:205-211`) — return
 * exactly this. Hono's `c.json` defaults to 200.
 *
 * There is NO harness status in this response. See
 * `HARNESS_CONTRACT_DIVERGENCES.postReturnsStatus`, which is the single highest-value
 * finding in this file.
 */
export const HARNESS_POST_SUCCESS = { status: 200, body: { ok: true } } as const

/**
 * `errorBody(code, message)` produces `{ error: { code, message } }`
 * (`claxedo-server-core/src/platform/http/http.ts:3-11`). The two failure codes this route can
 * produce:
 */
export const HARNESS_POST_MISSING_HARNESS = {
  status: 400,
  code: "agent_config_harness_required",
  /** `if (!body || !next)` — unparseable body OR unresolvable identity (:171). */
  source: "agent-config-harness-routes.ts:171",
} as const

export const HARNESS_POST_CHANGE_LOCKED = {
  status: 409,
  code: "agent_config_harness_change_locked",
  /**
   * Fires when a sessionId + workspace resolve, the requested harness differs from the
   * current one by `sameHarness` (id, access, and binary — agent-config-harness.ts:47-51),
   * AND the session already exists in ANY of three stores: an in-memory session config,
   * `sessionMeta`, or the sandbox (`:189-199`).
   */
  source: "agent-config-harness-routes.ts:189-199",
} as const

/**
 * Both handlers are gated by `localAgentConfigAllowed` FIRST
 * (`agent-config-harness-routes.ts:49-55` for GET, `:146-152` for POST), which delegates
 * to `localOnlyProjectionResponse` (`routes/local-only-projection.ts:117-151`). A
 * loopback request returns undefined and proceeds (:118); a non-loopback request without
 * a bearer token gets the control-plane auth error status, and otherwise 403 (:135-144).
 * The mock never exercises this because Playwright's page origin is loopback.
 */
export const HARNESS_LOCAL_ONLY_FORBIDDEN = { status: 403 } as const

/**
 * The GET route returns **200 on every path, including its own failure path**: the
 * `catch` at `agent-config-harness-routes.ts:130-142` returns `c.json({… status: "error",
 * error })` with no status override. A spec must therefore never treat a non-200 as the
 * way a harness failure surfaces — the failure is IN the 200 body.
 */
export const HARNESS_GET_STATUS = 200

/**
 * `status` values the GET body can carry. `"configured"` (:74) and `"error"` (:139) are
 * emitted by the route itself; the workspace path passes `body.status` straight through
 * from `/api/wr/health` (`:109`), which is where `"ready"` and `"applying"` come from.
 * The client only recognises these four — `harnessStatuses` in
 * `claxedo-app/src/features/session/harness/profile.ts:18` — and DROPS anything else.
 */
export const HARNESS_GET_STATUSES = ["configured", "ready", "applying", "error"] as const

/**
 * Asserts a POST response matches what claxedo-server actually returns.
 *
 * `strict` is OFF by default on purpose. The real route returns `{ ok: true }` and
 * nothing else, but today's mock returns a full harness-status payload
 * (`mock-runtime.ts:1300-1303`) from POST as well as GET. Turning `strict` on is the
 * correct end state and will FAIL the current fixture — which is the point of recording
 * the divergence rather than quietly widening the contract to fit the mock. Leave it off
 * until the fixture is fixed, then delete the flag.
 */
export function assertHarnessPostResponse(body: unknown, url: string, opts: { strict?: boolean } = {}): void {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HarnessConfigContractError("POST", url, [`response must be a JSON object, got ${typeOf(body)}`])
  }
  const row = body as Record<string, unknown>
  const problems: string[] = []
  if (row.ok !== true) {
    problems.push(`response.ok must be literal true — the route returns c.json({ ok: true }) on every success path`)
  }
  if (opts.strict) {
    for (const field of Object.keys(row)) {
      if (field === "ok") continue
      problems.push(
        `response carries "${field}", which the real route never returns. `
          + `The client's postHarnessConfig decodes this response with decodeHarnessState `
          + `(harness-switcher.ts:175), so extra status fields let a spec exercise a `
          + `"settled from the POST response" path production can never reach.`,
      )
    }
  }
  if (problems.length > 0) throw new HarnessConfigContractError("POST", url, problems)
}

/**
 * Asserts a GET response carries the fields every one of the route's three exit paths
 * guarantees: the no-workspace path (`:68-75`), the workspace path (`:102-129`), and the
 * catch path (`:131-141`). All three spread a `SessionHarness` at the top level and emit
 * `harness`, `activeType`, `activeHarness`, `activeBinary` and `status`.
 *
 * Asserted on the MOCK's own response so the fixture cannot drift into returning a shape
 * the real route never produces. Today it DOES — see
 * `HARNESS_CONTRACT_DIVERGENCES.getShapeDrift`.
 */
export function assertHarnessStatusResponse(body: unknown, url: string): void {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HarnessConfigContractError("GET", url, [`response must be a JSON object, got ${typeOf(body)}`])
  }
  const row = body as Record<string, unknown>
  const problems: string[] = []

  // The spread `...harness` / `...(saved ?? harness)` puts SessionHarness's own fields
  // at the top level on every path (:70, :104, :133).
  for (const [field, spec] of Object.entries(HARNESS_RESULT_FIELDS)) {
    const problem = spec.check(row[field])
    if (problem) problems.push(problem)
  }

  // `harness` and `activeHarness` are whole SessionHarness objects (:69, :72, :103, :118).
  for (const key of ["harness", "activeHarness"]) {
    const nested = row[key]
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
      problems.push(`response.${key} must be a SessionHarness object, got ${typeOf(nested)}`)
      continue
    }
    const nestedRow = nested as Record<string, unknown>
    for (const [field, spec] of Object.entries(HARNESS_RESULT_FIELDS)) {
      const problem = spec.check(nestedRow[field])
      if (problem) problems.push(`${key}.${problem}`)
    }
  }

  if (typeof row.activeType !== "string" || row.activeType.length === 0) {
    problems.push(
      "response.activeType must be a non-empty string — it is the access-qualified harness KEY "
        + "and is what `activeHarness(data)` resolves the ACTIVE harness from "
        + "(profile.ts:59). Omitting it makes desired-vs-active drift unobservable.",
    )
  }
  if (row.activeBinary !== null && typeof row.activeBinary !== "string") {
    problems.push(`response.activeBinary must be a string or null, got ${typeOf(row.activeBinary)}`)
  }
  if (typeof row.status !== "string") {
    problems.push(`response.status must be a string, got ${typeOf(row.status)}`)
  } else if (!(HARNESS_GET_STATUSES as readonly string[]).includes(row.status)) {
    problems.push(
      `response.status ${JSON.stringify(row.status)} is outside ${JSON.stringify(HARNESS_GET_STATUSES)} — `
        + "the client's decodeHarnessState DROPS an unrecognised status (profile.ts:89), leaving the "
        + "harness stuck in whatever state it was already in.",
    )
  }

  if (problems.length > 0) throw new HarnessConfigContractError("GET", url, problems)
}

// ---------------------------------------------------------------------------
// (4) Recorded divergences between the mock fixture and the real server
// ---------------------------------------------------------------------------

/**
 * Every difference found while binding this route, with the mock site and the server
 * site. These are NOT approved-forever; they are the work list this binding exists to
 * produce. Nothing here edits `mock-runtime.ts` — that is another change's job.
 */
export const HARNESS_CONTRACT_DIVERGENCES: Readonly<Record<string, string>> = {
  postReturnsStatus:
    "HIGHEST VALUE. The mock returns a full harness-status payload from POST "
    + "(mock-runtime.ts:1300-1303); the real route returns ONLY `{ ok: true }` "
    + "(agent-config-harness-routes.ts:202, :211). The client feeds the POST response to "
    + "decodeHarnessState and then applyPostedStatus (harness-switcher.ts:175, :190-195), so "
    + "mocked specs can observe a switch settling as ready/error DIRECTLY FROM THE POST — a "
    + "path production can never take, because decodeHarnessState({ok:true}) yields `{}` and "
    + "failedHarness({}) is false.",
  fetchHarnessStatusIsDeadCode:
    "Consequence of the above, in the OTHER direction: harness-switcher.ts:175 reads "
    + "`decodeHarnessState(...) ?? await fetchHarnessStatus(...) ?? true`. Against the real "
    + "server decodeHarnessState returns `{}` — TRUTHY — so the `??` short-circuits and "
    + "fetchHarnessStatus (:197-211) never runs in production. The mock cannot expose this "
    + "because it also returns a decodable payload.",
  getShapeDrift:
    "The mock's GET returns `{type, model, ok, status, ready}` (mock-runtime.ts:1298-1303). The "
    + "real GET returns `{harness, id, access, connection?, activeType, activeHarness, "
    + "activeBinary, status, …}` (agent-config-harness-routes.ts:68-75, :102-129) and never emits "
    + "`type` or `ok` at all. The client survives only because decodeHarnessState falls back "
    + "from `id` to `type` (profile.ts:88). With `activeType` absent from the fixture, "
    + "`activeHarness(data)` collapses onto `data.type` (profile.ts:59), so no spec can catch a "
    + "desired-vs-active mismatch — the exact failure the field exists to express.",
  opencodeBranchOmitsStatus:
    "The mock's opencode branch returns `{type:\"opencode\", ok:true}` with NO `status` and no "
    + "`ready` (mock-runtime.ts:1302). Every real GET path sets `status` — \"configured\" (:74), "
    + "the health passthrough (:109), or \"error\" (:139).",
  changeLockNeverFires:
    "The mock switches harness unconditionally (mock-runtime.ts:1292). The real server answers "
    + "HTTP 409 `agent_config_harness_change_locked` when a session already exists and the "
    + "harness identity or binary differs (agent-config-harness-routes.ts:189-199). Specs that "
    + "switch harness on an EXISTING session are asserting behaviour the real server rejects.",
  binaryIgnored:
    "The mock reads only `body.type` (mock-runtime.ts:1286, :1292) and drops `binary`, "
    + "`sessionId` and `directory`. The real server turns `binary` into "
    + "`connection.kind === \"process\"` (agent-config-harness.ts:66-67) and compares it in "
    + "`sameHarness` (:47-51), and routes on `sessionId`/`directory` "
    + "(agent-config-harness-routes.ts:172-181) to choose per-session vs global persistence.",
  legacyKeyEcho:
    "The mock echoes back the posted string verbatim. The real server re-derives the key: it "
    + "normalizes \"claude-sdk\"/\"codex-app-server\"/\"cursor-sdk\" to {id, access} "
    + "(harness-types.ts:129-131) and then emits `activeType = harnessKey(saved)` "
    + "(agent-config-harness-routes.ts:117), which is the CANONICAL key \"claude\"/\"codex\"/"
    + "\"cursor\". The app posts the legacy spellings (HARNESS_IDS, "
    + "claxedo-app/src/platform/identity/session-ref.ts:12-21), so the string that comes back "
    + "from a real server is NOT the string that went out.",
  missingBodyIsA400:
    "The mock tolerates an unparseable body and falls through to a 200 (mock-runtime.ts:1287-1292). "
    + "The real route returns HTTP 400 `agent_config_harness_required` "
    + "(agent-config-harness-routes.ts:162, :171).",
}

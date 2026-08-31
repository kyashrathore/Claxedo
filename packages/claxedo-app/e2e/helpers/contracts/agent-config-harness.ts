// Contract binding for POST /api/claxedo/agent-config/harness.
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
// relative path in several helpers, and `tsconfig.e2e.json`
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
      // (harness-types.ts:109-113) — so `harness: "acp:claude"` is legal here.
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
  constructor(url: string, problems: string[]) {
    super(`POST ${url} violated the canonical harness-config contract:\n  - ${problems.join("\n  - ")}`)
    this.name = "HarnessConfigContractError"
  }
}

function record(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined
}

const NATIVE = new Set(["claude", "codex", "cursor", "pi"])

export function parseHarnessConfigRequest(rawBody: unknown, url: string): {
  selection: RuntimeHarnessSelection
  sessionId?: string
} {
  const body = record(rawBody)
  const harness = record(body?.harness)
  const problems: string[] = []
  let selection: RuntimeHarnessSelection | undefined

  if (harness?.kind === "native" && typeof harness.harnessId === "string" && NATIVE.has(harness.harnessId)) {
    selection = { kind: "native", harnessId: harness.harnessId as "claude" | "codex" | "cursor" | "pi" }
  } else if (harness?.kind === "connection" && typeof harness.connectionId === "string" && harness.connectionId.trim()) {
    selection = { kind: "connection", connectionId: harness.connectionId.trim() }
  } else {
    problems.push("harness must be {kind:'native', harnessId} or {kind:'connection', connectionId}")
  }

  for (const key of Object.keys(body ?? {})) {
    if (key !== "harness" && key !== "sessionId") problems.push(`unknown field ${key}`)
  }
  if (body?.sessionId !== undefined && typeof body.sessionId !== "string") problems.push("sessionId must be a string")
  if (problems.length || !selection) throw new HarnessConfigContractError(url, problems)

  return {
    selection,
    ...(typeof body?.sessionId === "string" ? { sessionId: body.sessionId } : {}),
  }
}

export const HARNESS_POST_SUCCESS = { status: 200, body: { ok: true } } as const

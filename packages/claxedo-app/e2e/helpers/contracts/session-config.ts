// `SESSION_CREATE_CONFIG_FIELDS` in `./session-create.ts` covers the same type for `POST /session`, which runs the same normalizer; the tables stay separate because `harness` picks the harness on create but forces a 409 on PATCH.
import type { SessionConfigRequestUpdate } from "@claxedo/agent-sdk-runtime"
import { normalizeSessionConfigUpdate } from "../../../../workspace-runtime/src/session-config"

type FieldSpec = {
  /** Runtime check. Receives the raw value; returns an error string, or undefined when valid. */
  check: (value: unknown) => string | undefined
  /**
   * What `normalizeSessionConfigUpdate` does with this field, quoted from the line
   * that reads it. Documents the difference between "accepted", "silently dropped",
   * and "meaningful when present" — which for this route is the whole game.
   */
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
 * Every field of the server's public `SessionConfigRequestUpdate`, with the rule the PATCH route
 * actually applies to it.
 *
 * The `satisfies Record<keyof Required<SessionConfigRequestUpdate>, FieldSpec>` clause is the
 * tripwire: this object must carry EXACTLY the server type's keys
 * (`agent-sdk-runtime/src/index.ts:159-164`). A new config field server-side leaves
 * this table missing a key and typecheck fails; a removed one leaves an excess key and
 * typecheck fails.
 */
export const SESSION_CONFIG_PATCH_FIELDS = {
  harness: {
    check: (value) => {
      if (value === undefined) return undefined
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return `harness must be an object, got ${typeOf(value)}`
      }
      const harness = value as Record<string, unknown>
      // `normalizeHarnessIdentity` (agent-runtime-contract's `harnesses.ts`)
      // accepts a native id, or `{ id: <connection id>, access: "connection" }`
      // for an operator connection (`claude-acp`); the retired `type` alias and
      // the colon-form `acp:<slug>` presentation resolve to nothing.
      // With neither, it returns undefined, `normalizeSessionHarness` returns undefined
      // (session-config.ts:26-27), and the whole `harness` key is dropped from the
      // update object (session-config.ts:91) — a silent no-op, not an error.
      const identity = typeof harness.id === "string" ? harness.id : typeof harness.type === "string" ? harness.type : undefined
      if (identity === undefined) {
        return `harness must carry a string \`id\` (or the legacy \`type\` alias) — `
          + `normalizeHarnessIdentity returns undefined otherwise and normalizeSessionHarness `
          + `DROPS the whole harness key (session-config.ts:26-27, 91), so the PATCH would `
          + `200 without changing anything`
      }
      if (harness.access !== undefined && typeof harness.access !== "string") {
        return `harness.access must be a string when present, got ${typeOf(harness.access)}`
      }
      return undefined
    },
    consumedBy:
      "normalizeSessionHarness(row.harness ?? legacyRunner) (session-config.ts:84). "
      + "PRESENT + resolvable harness additionally arms the harness-switch guard: the route "
      + "re-reads the session's current config and 409s unless sameSessionHarness() holds "
      + "(session-core.ts:555-567) — see SESSION_CONFIG_PATCH_HARNESS_SWITCH below",
  },
  model: {
    check: (value) => {
      // `null` is MEANINGFUL and distinct from absent. `promptModel` returns `null`
      // for a literal null (session-config.ts:71), and the normalizer keeps the key
      // because it spreads on `model !== undefined` (session-config.ts:92) — i.e.
      // `{ model: null }` reaches the adapter as an explicit "clear the model".
      // Omitting the key entirely leaves the stored model unchanged.
      if (value === undefined || value === null) return undefined
      if (typeof value !== "object" || Array.isArray(value)) {
        return `model must be an object or null, got ${typeOf(value)}`
      }
      const model = value as Record<string, unknown>
      // `promptModel` (session-config.ts:70-79) bails to `undefined` unless BOTH
      // providerID and modelID are strings (:74). Because the normalizer's spread is
      // gated on `model !== undefined`, a half-filled model does not clear the model
      // and does not error — the key vanishes and the PATCH is a 200 no-op. That is
      // precisely the shape a spec must never be allowed to assert around, so it is a
      // hard failure here even though the server tolerates it.
      if (typeof model.providerID !== "string" || typeof model.modelID !== "string") {
        return `model must carry BOTH providerID and modelID as strings — promptModel `
          + `(session-config.ts:74) returns undefined otherwise, which is a SILENT no-op `
          + `server-side (not an error, and NOT the same as model: null which clears it). `
          + `Got providerID=${typeOf(model.providerID)} modelID=${typeOf(model.modelID)}`
      }
      return undefined
    },
    consumedBy:
      '"model" in row ? promptModel(row.model) : <legacy runner fallback> (session-config.ts:85-89); '
      + "kept only when the result is `!== undefined` (:92), so null clears and partial drops",
  },
  variant: {
    check: nullableString("variant"),
    consumedBy:
      'kept only when `"variant" in row` AND the value is a string or null (session-config.ts:93). '
      + "The `in` check means `{ variant: undefined }` and an absent `variant` are NOT the same "
      + "over the wire — but JSON.stringify erases explicit undefined, so an explicit-undefined "
      + "variant can never actually reach the server from a JSON client. It can only reach it "
      + "as `null`, which is the real \"clear the variant\" signal",
  },
  agent: {
    check: nullableString("agent"),
    consumedBy:
      'kept only when `"agent" in row` AND the value is a string or null (session-config.ts:94) — '
      + "same presence semantics as `variant`",
  },
} satisfies Record<keyof Required<SessionConfigRequestUpdate>, FieldSpec>

/**
 * Non-`SessionConfigUpdate` body fields the PATCH route still legitimately accepts.
 *
 * The route hands the RAW body to `normalizeSessionConfigUpdate`
 * (`session-core.ts:554`) — it does not pre-filter, does not cast to a narrower
 * annotation, and shares the normalizer verbatim with `POST /session`
 * (`session-core.ts:448`). So YES, the legacy `runner` fallback is reachable on THIS
 * route: `record(row.runner)` at `session-config.ts:83` runs on every PATCH, feeding
 * both the harness fallback (:84) and the `{ type, model }`-to-`PromptModel` fallback
 * (:87-88) when `model` is absent from the body.
 *
 * Note the asymmetry worth remembering: `runner` only supplies the model when `"model"
 * in row` is false (:85). Sending both `model` and `runner` means `runner.model` is
 * ignored while `runner` can still supply the harness.
 */
export const SESSION_CONFIG_PATCH_LEGACY_FIELDS: Readonly<Record<string, FieldSpec>> = {
  runner: {
    check: (value) => {
      if (value === undefined) return undefined
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return `runner must be an object, got ${typeOf(value)}`
      }
      return undefined
    },
    consumedBy:
      "LEGACY: `const legacyRunner = record(row.runner)` (session-config.ts:83). Supplies the "
      + "harness when `harness` is absent (:84), and `{ providerID: runner.type, modelID: "
      + "runner.model }` when `model` is absent AND both are strings (:87-88)",
  },
}

export class SessionConfigPatchContractError extends Error {
  constructor(url: string, problems: string[]) {
    super(
      `PATCH ${url} violated the real server's session-config contract `
        + `(workspace-runtime/src/routes/session-core.ts:548-572 → src/session-config.ts:81-96):\n  - `
        + `${problems.join("\n  - ")}\n`
        + `This is a REAL failure: the mock now enforces what normalizeSessionConfigUpdate `
        + `enforces, so this request would have 200'd against a real backend WITHOUT applying `
        + `the change the spec is asserting.`,
    )
    this.name = "SessionConfigPatchContractError"
  }
}

/**
 * Validates an intercepted `PATCH /session/:id/config` body and returns the subset the
 * real normalizer would keep, typed as `SessionConfigUpdate`.
 *
 * `rawBody` is `Route.request().postDataJSON()`'s output — already JSON-parsed.
 *
 * An absent or non-object body is LEGAL: the route does
 * `normalizeSessionConfigUpdate(await c.req.json().catch(() => ({})))`
 * (`session-core.ts:554`) and `record()` (`session-config.ts:11-14`) turns any
 * non-object — including an array or a bare string — into `{}`. There is no 400 on
 * this route for a malformed body; it is an expensive 200 that changes nothing. This
 * validator mirrors that for absent/null (returns `{}`) but FAILS on a non-object
 * JSON payload, because a client that got that far is unambiguously broken and no spec
 * should be allowed to depend on the server's silence.
 */
export function parseSessionConfigPatch(rawBody: unknown, url: string): SessionConfigRequestUpdate {
  if (rawBody === undefined || rawBody === null) return {}
  if (typeof rawBody !== "object" || Array.isArray(rawBody)) {
    throw new SessionConfigPatchContractError(url, [
      `body must be a JSON object, got ${typeOf(rawBody)} — the server's record() helper `
        + `(session-config.ts:11-14) coerces this to {} and the PATCH becomes a silent no-op`,
    ])
  }

  const body = rawBody as Record<string, unknown>
  const problems: string[] = []
  const specs: Record<string, FieldSpec> = {
    ...SESSION_CONFIG_PATCH_FIELDS,
    ...SESSION_CONFIG_PATCH_LEGACY_FIELDS,
  }

  for (const [field, spec] of Object.entries(specs)) {
    const problem = spec.check(body[field])
    if (problem) problems.push(problem)
  }

  // A body that normalizes to `{}` is a wasted round trip against the real server: it
  // 200s, returns the unchanged config, and applies nothing. The app's own
  // `saveSessionConfig` (`src/features/session/composer/ui/submit-transport.ts:186-193`)
  // always sends at least `harness`, so an empty normalized result means the client
  // under test built a body out of fields the normalizer discards.
  const meaningful = Object.keys(specs).some((field) => field in body)
  if (!meaningful && Object.keys(body).length > 0) {
    problems.push(
      `body has keys [${Object.keys(body).join(", ")}] but none of them are read by `
        + `normalizeSessionConfigUpdate — the request would normalize to {} and change nothing`,
    )
  }

  for (const field of Object.keys(body)) {
    if (field in specs) continue
    problems.push(
      `unknown field "${field}" — normalizeSessionConfigUpdate (session-config.ts:81-96) reads `
        + `only harness/runner/model/variant/agent, so the real server silently DROPS it. Add it `
        + `to SessionConfigUpdate server-side, stop sending it, or document it here.`,
    )
  }

  if (problems.length > 0) throw new SessionConfigPatchContractError(url, problems)

  // Delegate the accepted body to the authoritative normalizer so connection
  // metadata and future normalization details cannot drift in this test binding.
  return normalizeSessionConfigUpdate(body)
}

/**
 * The real route's success status: `return c.json(config)` (`session-core.ts:571`) —
 * Hono's default 200, no explicit override. Pinned as a const so the mock cannot drift
 * into 204 or 201 the way the create route had drifted into 200.
 */
export const SESSION_CONFIG_PATCH_SUCCESS_STATUS = 200

/**
 * The success BODY is a full `SessionConfig`, not an acknowledgement. It is whatever
 * `opts.updateSessionConfig(...)` / `adapter.updateSessionConfig(...)` returns
 * (`session-core.ts:568-570`), and both are typed `Promise<SessionConfig>`
 * (`session-core.ts:133-139`, `agent-sdk-runtime/src/adapter-contract.ts:55`).
 *
 * `SessionConfig` (`agent-sdk-runtime/src/index.ts:143-148`) is:
 *   { harness: { id, access, connection? }; model?: PromptModel; variant?: string | null; agent?: string | null }
 *
 * Note `harness` is REQUIRED on the response even though it is optional on the update —
 * `normalizeSessionConfig` (`session-config.ts:98-108`) returns `undefined` outright
 * when it cannot resolve a harness, so any config the server does emit has one.
 */
export function assertSessionConfigPatchResponse(config: unknown, url: string): void {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new SessionConfigPatchContractError(url, [
      `success response must be a SessionConfig object, got ${typeOf(config)} — the real route `
        + `returns c.json(config) where config is Promise<SessionConfig> (session-core.ts:568-571), `
        + `NOT an acknowledgement like { ok: true }`,
    ])
  }
  const row = config as Record<string, unknown>
  const problems: string[] = []

  const harness = row.harness
  if (!harness || typeof harness !== "object" || Array.isArray(harness)) {
    problems.push("response.harness must be an object — SessionConfig.harness is REQUIRED (index.ts:143-148)")
  } else {
    const identity = harness as Record<string, unknown>
    if (typeof identity.id !== "string") problems.push("response.harness.id must be a string")
    if (typeof identity.access !== "string") problems.push("response.harness.access must be a string")
  }

  if (row.model !== undefined && row.model !== null) {
    if (typeof row.model !== "object" || Array.isArray(row.model)) {
      problems.push(`response.model must be an object when present, got ${typeOf(row.model)}`)
    } else {
      const model = row.model as Record<string, unknown>
      if (typeof model.providerID !== "string" || typeof model.modelID !== "string") {
        problems.push("response.model must carry providerID and modelID as strings (PromptModel)")
      }
    }
  }

  if (row.variant !== undefined && row.variant !== null && typeof row.variant !== "string") {
    problems.push(`response.variant must be a string or null, got ${typeOf(row.variant)}`)
  }
  if (row.agent !== undefined && row.agent !== null && typeof row.agent !== "string") {
    problems.push(`response.agent must be a string or null, got ${typeOf(row.agent)}`)
  }

  if (problems.length > 0) throw new SessionConfigPatchContractError(url, problems)
}

/**
 * The route's ONE self-generated failure: a harness switch.
 *
 * When the body resolves a `harness`, the route re-reads the session's current config
 * and calls `sameSessionHarness` (`session-core.ts:374-378`, comparing `id`, `access`,
 * and — only when the request supplied one — `connection`). On mismatch it returns
 * `harnessSwitchUnsupported` (`session-core.ts:380-392`), which is
 * `unsupportedOperation(..., "harness_switch", …)` (`session-core.ts:311-334`).
 *
 * Status is **409**, not 400 and not 500.
 */
export const SESSION_CONFIG_PATCH_HARNESS_SWITCH_STATUS = 409

/**
 * The exact failure envelope `unsupportedOperation` emits (`session-core.ts:322-333`).
 * `capability`, `harness`, `reason`, and `message` are supplied by
 * `harnessSwitchUnsupported`; `transport` is always `caps.harness`.
 */
export function sessionConfigPatchHarnessSwitchBody(input: {
  currentHarnessId: string
  requestedHarnessId: string
  /** `caps.harness` from `adapter.readHarnessCapabilities(...)` — the transport field. */
  transport: string
}) {
  return {
    ok: false,
    error: {
      code: "unsupported_operation",
      operation: "harness_switch",
      capability: "session_harness",
      harness: input.currentHarnessId,
      transport: input.transport,
      reason: "harness_switch_not_supported",
      message: `${input.currentHarnessId} sessions cannot switch to ${input.requestedHarnessId} through session config patch`,
    },
  } as const
}

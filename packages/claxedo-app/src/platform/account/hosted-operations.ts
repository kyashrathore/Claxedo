// target layer: account

/**
 * The one app-owned registry of hosted operation IDs and their result shapes.
 *
 * `account-port.ts` says the renderer names an operation rather than building a
 * request. This says what each name MEANS to the renderer: what it takes, and
 * what comes back. Electron main holds the matching method-and-path table; the
 * two are held equal to
 * `docs/tech-docs/desktop-hosted-operation-matrix.md` from both sides.
 *
 * Deliberately contains no transport. No bearer, no URL, no method, no fetch —
 * not because those are inconvenient here, but because a registry that could
 * express them would be a place to add a fourteenth operation that happens to
 * take a path. The value of a closed set is that it cannot be opened in
 * passing.
 *
 * Decoders rather than casts. A hosted response that changed shape should fail
 * where it arrives, naming the operation, instead of surfacing three components
 * later as `undefined is not an object`.
 */

import type { HostedOperationName } from "./account-port"

export type { HostedOperationName }

/** What a caller passes. Parameters, never a request shape. */
export type HostedOperationInput = Record<string, string | number | boolean | undefined>

export type DecodeResult<T> = { ok: true; value: T } | { ok: false; reason: string }

/**
 * One row: what the operation is for, and how to read its answer.
 *
 * `safe` marks an operation with no side effect, which is the only property the
 * renderer needs in order to decide whether a retry is its own decision to
 * make. Anything unsafe is main's call, because main is where the idempotency
 * key lives.
 */
export type HostedOperationSpec<T = unknown> = {
  safe: boolean
  decode: (raw: unknown) => DecodeResult<T>
}

function object(raw: unknown): DecodeResult<Record<string, unknown>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "expected an object" }
  return { ok: true, value: raw as Record<string, unknown> }
}

function array(raw: unknown): DecodeResult<unknown[]> {
  if (!Array.isArray(raw)) return { ok: false, reason: "expected an array" }
  return { ok: true, value: raw }
}

/** Requires named fields to be present and non-empty strings. */
function withStrings(...fields: string[]) {
  return (raw: unknown): DecodeResult<Record<string, unknown>> => {
    const shape = object(raw)
    if (!shape.ok) return shape
    for (const field of fields) {
      if (typeof shape.value[field] !== "string" || shape.value[field] === "") {
        return { ok: false, reason: `expected a non-empty "${field}"` }
      }
    }
    return shape
  }
}

export const HOSTED_OPERATIONS: Record<HostedOperationName, HostedOperationSpec> = {
  "account.get": { safe: true, decode: object },
  "account.mode": { safe: true, decode: object },
  "account.compatibility": { safe: true, decode: object },
  // Mints a CLI session token. A replayed exchange must not mint twice, and
  // the idempotency key for that lives in main.
  "account.cliExchange": { safe: false, decode: object },
  "workspace.list": { safe: true, decode: array },
  "workspace.resolve": { safe: true, decode: object },
  // Provisions a cloud VM. Without a key, an uncertain response creates a
  // second one.
  "workspace.create": { safe: false, decode: withStrings("id") },
  "workspace.lifecycle": { safe: false, decode: object },
  "workspace.checkpoints.list": { safe: true, decode: array },
  // Destructive to working state.
  "workspace.checkpoints.restore": { safe: false, decode: object },
  // Returns a relay URL and a scoped token — and deliberately no laptop
  // address; the decoder requires the field that must be there rather than
  // asserting the absence of one that must not.
  "workspace.connection.mint": { safe: true, decode: withStrings("relayUrl") },
  "workspace.connection.refresh": { safe: true, decode: withStrings("relayUrl") },
  "host.enrollCurrentMachine": { safe: false, decode: withStrings("host_id") },
}

export function hostedOperationNames(): HostedOperationName[] {
  return Object.keys(HOSTED_OPERATIONS) as HostedOperationName[]
}

/**
 * Decode one operation's result, naming the operation on failure.
 *
 * The name in the message is the point. "expected a non-empty relayUrl" from an
 * unnamed decoder sends someone reading the wrong route.
 */
export function decodeHostedResult<T = unknown>(name: HostedOperationName, raw: unknown): T {
  const spec = HOSTED_OPERATIONS[name]
  if (!spec) throw new Error(`no hosted operation named "${name}"`)
  const decoded = spec.decode(raw)
  if (!decoded.ok) throw new Error(`hosted operation "${name}" returned an unexpected shape: ${decoded.reason}`)
  return decoded.value as T
}

/** Whether the renderer may retry this operation on its own. */
export function isSafeOperation(name: HostedOperationName) {
  return HOSTED_OPERATIONS[name]?.safe === true
}

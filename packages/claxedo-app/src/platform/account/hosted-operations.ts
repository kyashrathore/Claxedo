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
 * make. Anything unsafe is main's call.
 *
 * This used to say "because main is where the idempotency key lives". Main has
 * no idempotency key, for any operation — `claxedo-desktop`'s operation table
 * expresses a request as method + path + declared body and has no header seam,
 * and no route it names accepts a key in its body. So `safe: false` means
 * exactly what it says and nothing more: DO NOT RETRY. It is not a promise that
 * someone downstream will make a retry harmless.
 */
export type HostedOperationSpec<T = unknown> = {
  safe: boolean
  decode: (raw: unknown) => DecodeResult<T>
}

function object(raw: unknown): DecodeResult<Record<string, unknown>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "expected an object" }
  return { ok: true, value: raw as Record<string, unknown> }
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

/** Requires a named field holding an array. The envelope is returned as sent. */
function withArray(field: string) {
  return (raw: unknown): DecodeResult<Record<string, unknown>> => {
    const shape = object(raw)
    if (!shape.ok) return shape
    if (!Array.isArray(shape.value[field])) return { ok: false, reason: `expected an array "${field}"` }
    return shape
  }
}

/** Requires a named field holding an object, checked by `inner`. */
function withRecord(field: string, inner: (raw: unknown) => DecodeResult<unknown>) {
  return (raw: unknown): DecodeResult<Record<string, unknown>> => {
    const shape = object(raw)
    if (!shape.ok) return shape
    const nested = inner(shape.value[field])
    if (!nested.ok) return { ok: false, reason: `expected "${field}": ${nested.reason}` }
    return shape
  }
}

/**
 * `null`, or whatever `decode` accepts.
 *
 * Not a loosening of `object`. A route that answers `null` is answering
 * something — `GET /api/workspace/resolve` on the hosted control plane returns
 * it deliberately, as the documented "no central runtime snapshot" signal — and
 * a decoder that rejects it turns a correct answer into a crash. Bending
 * `object` to let nulls through instead would have made every other operation
 * silently null-tolerant, which is the opposite of what these decoders are for.
 */
function nullable<T>(decode: (raw: unknown) => DecodeResult<T>) {
  return (raw: unknown): DecodeResult<T | null> => (raw === null ? { ok: true, value: null } : decode(raw))
}

/**
 * A workspace connection: a mint, or the poll that precedes one.
 *
 * `relayUrl` is required, EXCEPT while the sandbox is still coming up. A cold
 * start answers 200 with `status: "provisioning"` and a `retryAfterMs`, and the
 * client is expected to poll — so a decoder that demanded `relayUrl`
 * unconditionally would fail every cold start, which is precisely when the user
 * is watching. The requirement still bites for a settled connection, which is
 * the case it exists to protect: a ready connection with no relay URL would be
 * a client with nowhere to connect.
 */
function connection(raw: unknown): DecodeResult<Record<string, unknown>> {
  const shape = object(raw)
  if (!shape.ok) return shape
  if (shape.value["status"] === "provisioning") return shape
  return withStrings("relayUrl")(raw)
}

export const HOSTED_OPERATIONS: Record<HostedOperationName, HostedOperationSpec> = {
  "account.get": { safe: true, decode: object },
  "account.mode": { safe: true, decode: object },
  "account.compatibility": { safe: true, decode: object },
  // Mints a CLI session token. A replayed exchange must not mint twice — and
  // nothing prevents it: the route mints from the bearer and never reads the
  // body, so every call is a fresh, separately-revocable pair. Unreachable from
  // here in any case; Electron main refuses this operation to the renderer
  // (`RENDERER_WITHHELD_OPERATIONS`).
  "account.cliExchange": { safe: false, decode: object },
  // An ENVELOPE, not a bare array: `GET /api/workspace` answers
  // `{ workspaces: [...] }`, the same shape the local server's list handler
  // uses. Validated and passed through rather than unwrapped, because every
  // other row here validates without transforming and one decoder that quietly
  // reshapes its answer is a decoder nobody can read the registry to predict.
  "workspace.list": { safe: true, decode: withArray("workspaces") },
  // Nullable: the hosted control plane answers `null` on purpose.
  "workspace.resolve": { safe: true, decode: nullable(object) },
  // Provisions a cloud VM. Without a key, an uncertain response creates a
  // second one — and there is no key: the hosted route's body schema is strict
  // and has no idempotency field, so one cannot be sent from a client at all.
  // `safe: false` is therefore the whole protection, and the disposition for an
  // uncertain response is to surface it, not to retry. Answers
  // `{ workspaceId, directory }` — `directory` is what the caller opens, so an
  // answer without one is not a usable workspace.
  "workspace.create": { safe: false, decode: withStrings("workspaceId", "directory") },
  "workspace.lifecycle": { safe: false, decode: object },
  // The lifecycle SNAPSHOT — lease, checkpoint, worktrees, runtime — not a
  // list. The route is `GET /:id/checkpoints` and the name has misled twice.
  "workspace.checkpoints.list": { safe: true, decode: object },
  // Destructive to working state.
  "workspace.checkpoints.restore": { safe: false, decode: object },
  // Returns a relay URL and a scoped token — and deliberately no laptop
  // address; the decoder requires the field that must be there rather than
  // asserting the absence of one that must not.
  "workspace.connection.mint": { safe: true, decode: connection },
  "workspace.connection.refresh": { safe: true, decode: connection },
  // Wrapped: the route returns `{ enrollment }`. Reading `host_id` off the
  // envelope finds nothing, which is exactly what this decoder existed to
  // prevent and exactly what it did.
  "host.enrollCurrentMachine": {
    safe: false,
    decode: withRecord("enrollment", withStrings("enrollment_id", "host_id")),
  },
  // Unsafe: each call mints a nonce, so a retry burns one. The nonce itself is
  // public and worthless without the machine's private key.
  "host.enrollmentNonce": { safe: false, decode: withStrings("request_id", "nonce") },
  // Safe: the server extends an existing enrollment rather than creating
  // anything, and a heartbeat that arrives twice is a heartbeat. A REJECTED one
  // is not retried at all — the connector stops, because re-enrolling would be
  // it overruling a revocation.
  "host.enrollmentHeartbeat": { safe: true, decode: object },
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

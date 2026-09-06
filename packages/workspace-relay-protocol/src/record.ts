/**
 * The one narrowing step every wire boundary in this package starts from.
 *
 * Tunnel frames and verifier responses both arrive as `unknown` (parsed JSON),
 * and both need the same first question answered before any field can be read:
 * "is this a keyed object at all?". Answering it with a type predicate rather
 * than a cast keeps the rest of each validator honest — every field it reads is
 * `unknown` until it is checked.
 */
export function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null
}

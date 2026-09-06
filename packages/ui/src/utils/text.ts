/**
 * Render a value of unknown shape as text a person can read.
 *
 * A file viewer's contents and a turn's error message are both declared as
 * `string` but sourced from an untrusted payload, so each defends against the
 * value being something else. `String()` is right for the primitives and wrong
 * for objects: it renders the literal text `[object Object]`, which as a file
 * body or an error line tells the reader nothing about what actually arrived.
 *
 * Nullish is "nothing to read", not "unreadable", so it yields the empty
 * string: both callers made that same choice separately before this existed.
 */
export function readableText(value: unknown): string {
  if (value === null) return ""
  switch (typeof value) {
    case "undefined":
      return ""
    case "string":
      return value
    case "number":
    case "boolean":
    case "bigint":
    case "symbol":
    case "function":
      // Each of these carries its own `toString`; only objects fall back to Object's.
      return String(value)
    default:
      // Everything left is an object: `typeof` has no ninth result.
      return objectText(value)
  }
}

/**
 * Serialize an object rather than stringify it, handling the two shapes that
 * defeat `JSON.stringify`: an `Error` serializes to `{}` because its fields are
 * not enumerable, and a circular structure (or a `bigint` field, or a `toJSON`
 * that throws) throws outright.
 */
function objectText(value: object): string {
  if (value instanceof Error) return value.message
  try {
    return JSON.stringify(value)
  } catch {
    // The value is real but unprintable; name its type rather than drop it.
  }
  if ("constructor" in value && typeof value.constructor === "function") {
    return `[unserializable ${value.constructor.name}]`
  }
  return "[unserializable value]"
}

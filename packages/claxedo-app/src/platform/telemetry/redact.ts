/**
 * One-way digests for values that identify a person or their machine. Telemetry
 * may count repeat occurrences of such a value; it may never carry the value.
 */

/**
 * FNV-1a, 32-bit, hex. Synchronous and dependency-free so redaction happens on
 * the same tick as the capture call. Not a cryptographic hash: it exists to make
 * the same input countable across events, and nothing in the payload may depend
 * on recovering the input.
 */
export function fnv1aHex(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

/**
 * Replace a filesystem path with the two facts telemetry actually needs: what
 * kind of file it was, and whether it is the same file as last time. No
 * directory names, no basename — a basename is as identifying as the path.
 */
export function redactedPath(path: string): { extension: string; path_hash: string } {
  const base = path.slice(path.lastIndexOf("/") + 1)
  const dot = base.lastIndexOf(".")
  return {
    extension: dot > 0 ? base.slice(dot + 1).toLowerCase() : "",
    path_hash: fnv1aHex(path),
  }
}

/**
 * Hash every path-shaped value in a property bag. Flow events are assembled from
 * arbitrary call-site objects (workspace directories, route directories, created
 * worktrees), so redaction belongs at the sink rather than at each producer.
 */
export function redactedPathValues(properties: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(properties)) {
    const pathShaped = typeof value === "string" && (value.includes("/") || value.includes("\\"))
    redacted[key] = pathShaped ? fnv1aHex(value as string) : value
  }
  return redacted
}

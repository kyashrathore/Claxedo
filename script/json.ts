/**
 * Reading JSON the repository's own tooling depends on — package manifests,
 * build manifests, CLI output.
 *
 * `JSON.parse` returns `any`, so every reader used to assert the shape it hoped
 * for and then index into it. These narrow instead: the check and the type stay
 * together, and a manifest that has drifted shows up as a missing field at the
 * read rather than as `undefined` several frames later.
 */

export function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input)
}

export function record(input: unknown): Record<string, unknown> | undefined {
  return isRecord(input) ? input : undefined
}

/** Parse a JSON object, naming the file when it turns out not to be one. */
export function parseJsonObject(source: string, file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(source)
  if (!isRecord(value)) throw new Error(`${file} is not a JSON object`)
  return value
}

export function text(input: unknown): string | undefined {
  return typeof input === "string" && input.length > 0 ? input : undefined
}

/** The string members of an array value; anything else is dropped. */
export function stringList(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined
  return input.filter((item): item is string => typeof item === "string")
}

/** The string-valued entries of an object; a manifest's `dependencies`, say. */
export function stringRecord(input: unknown): Record<string, string> {
  const row = record(input)
  if (!row) return {}
  return Object.fromEntries(Object.entries(row).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
}

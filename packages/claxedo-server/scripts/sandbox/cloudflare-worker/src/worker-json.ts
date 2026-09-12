// This Worker is deployed with `npm ci && wrangler deploy` from its own
// package.json, which declares no workspace dependency, so it cannot import
// `@claxedo/helpers/guards`. These are the Worker's own copies, in one place so
// the routes and the credential handler narrow untrusted JSON the same way.

export function isWorkerRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function asWorkerRecord(value: unknown): Record<string, unknown> | undefined {
  return isWorkerRecord(value) ? value : undefined
}

/** Only the string entries of an object; a non-string env or label value is not one. */
export function stringMap(value: unknown): Record<string, string> {
  const record = asWorkerRecord(value)
  if (!record) return {}
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

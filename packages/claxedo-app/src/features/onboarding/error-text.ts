/**
 * The readable text a thrown value carries.
 *
 * Setup's failure-copy functions all match on the server's own words, so they
 * need one answer to "what did this throw say?". `claxedoCredentialRequest` and
 * `api` throw `Error`s holding the server message; anything else is serialised
 * rather than stringified, because `String(someObject)` yields `[object
 * Object]` — text that matches nothing and tells the user nothing.
 */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error === undefined || error === null) return ""
  return JSON.stringify(error) ?? ""
}

/**
 * The `claxedo://document/<id>` reference the app copies to the clipboard.
 *
 * It is read wherever a person can paste one — the MCP document tools and the
 * `claxedo documents` CLI — and both then look the id up the same way, so the
 * parsing lives here rather than once per entrypoint.
 */

/** A document reference whose percent escapes are malformed; typed so a caller refuses the input rather than catching a bare URIError. */
export class InvalidDocumentReferenceError extends Error {
  constructor(reference: string) {
    super(`'${reference}' is not a readable claxedo://document/... reference`)
    this.name = "InvalidDocumentReferenceError"
  }
}

/** The document id a reference names, or the input trimmed, which a caller treats as an id or a display name. */
export function claxedoDocumentReferenceId(value: string): string {
  const id = /^claxedo:\/\/document\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(value.trim())?.[1]
  if (id === undefined) return value.trim()
  try {
    return decodeURIComponent(id)
  } catch {
    throw new InvalidDocumentReferenceError(value.trim())
  }
}

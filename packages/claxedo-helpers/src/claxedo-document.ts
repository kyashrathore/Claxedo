/**
 * The `claxedo://document/<id>` reference the app copies to the clipboard.
 *
 * It is read wherever a person can paste one — the MCP document tools and the
 * `claxedo documents` CLI — and both then look the id up the same way, so the
 * parsing lives here rather than once per entrypoint.
 */

/** The document id a reference names, or the input trimmed, which a caller treats as an id or a display name. */
export function claxedoDocumentReferenceId(value: string): string {
  const id = /^claxedo:\/\/document\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(value.trim())?.[1]
  return id === undefined ? value.trim() : decodeURIComponent(id)
}

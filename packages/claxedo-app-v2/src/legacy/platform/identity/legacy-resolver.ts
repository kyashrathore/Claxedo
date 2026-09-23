// The ONE file allowed to sniff legacy directory strings.
// New callers are a ratchet failure; move callers toward SessionRef instead.
//
// This file is one of the two sanctioned brand-mint owners. The string
// sniffers below are the single legal `string -> WorkspaceId` narrowing point
// (`workspaceIdFromRef`); the route parser owns `string -> DirectoryRef` for
// route params. Everywhere else the brands are received, never minted.
import { asWorkspaceId, type WorkspaceId } from "./brand"

export function isFilesystemDirectory(input: string | undefined) {
  return !!input && (input.startsWith("/") || /^[A-Za-z]:[\\/]/.test(input))
}

export function isWorkspaceIdRef(input: string | undefined) {
  return !!input && /^ws_[A-Za-z0-9_-]+$/.test(input.trim())
}

/** Local sidecar association id (`randomUUID`), never a signed `ws_*` id. */
export function localWorkspaceAssociationId(input: string | undefined): string | undefined {
  const value = input?.trim()
  if (!value) return undefined
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined
}

export function workspaceIdFromRef(input: string | undefined): WorkspaceId | undefined {
  const prefixed = input?.match(/^workspace:(ws_[A-Za-z0-9_-]+|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i)?.[1]
  if (prefixed) return asWorkspaceId(prefixed)
  const ref = isWorkspaceIdRef(input) ? input?.trim() : undefined
  return ref ? asWorkspaceId(ref) : undefined
}

/**
 * One key for every spelling of a directory that names the same workspace.
 *
 * A relay-backed workspace is addressed both by its bare id (session
 * inventory, draft promotion, the `/w/:id` route's `dir()`) and by the
 * `workspace:<id>` address session rows and the pane SDK carry. A cache entry
 * keyed by the raw string is written under one spelling and missed under the
 * other, so anything that keys a session resource by directory keys it by this.
 */
export function workspaceDirectoryAliasKey(input: string | undefined) {
  if (!input) return ""
  const workspaceId = workspaceIdFromRef(input)
  if (workspaceId) return `workspace:${workspaceId}`
  // macOS resolves /tmp, /var, /etc to /private/* symlinks, so the directory a
  // runtime reports (/tmp/...) and the one the browser sees (/private/tmp/...)
  // differ for the same worktree. Normalise the /private prefix so they match.
  return input.startsWith("/private/") ? input.slice("/private".length) : input
}

export function sameWorkspaceDirectory(left: string | null | undefined, right: string | null | undefined) {
  return !!left && !!right && workspaceDirectoryAliasKey(left) === workspaceDirectoryAliasKey(right)
}

/**
 * Whether a directory forces the signed path, whatever it turns out to be.
 *
 * One arm today, and kept as a name because the question is not the mechanism:
 * callers ask "must this be read through the control plane", and answering it
 * by spelling `isFilesystemDirectory` at each call site moves a legacy string
 * sniff out of this file — which the header above forbids and the
 * `isFilesystemDirectory` ratchet counts.
 */
export function requiresSignedLegacyDirectory(input: string | undefined) {
  return isFilesystemDirectory(input)
}

export function usesScopedSessionTransport(sessionID: string | undefined, directory?: string) {
  return !!sessionID && (
    requiresSignedLegacyDirectory(directory) ||
    !sessionID.startsWith("ses") ||
    !!workspaceIdFromRef(directory)
  )
}

export function isLocalSessionDirectory(input: string | undefined): input is string {
  if (!input) return false
  // An absolute path never starts with `workspace:`, so the ref test answers
  // it too.
  return !input.startsWith("workspace:")
}

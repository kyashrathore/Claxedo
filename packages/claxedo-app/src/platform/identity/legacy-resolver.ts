// The ONE file allowed to sniff legacy directory strings (org doc §1).
// New callers are a ratchet failure; move callers toward SessionRef instead.
//
// WP-D5: this file is one of the two sanctioned brand-mint owners. The string
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

export function workspaceIdFromRef(input: string | undefined): WorkspaceId | undefined {
  const prefixed = input?.match(
    /^workspace:(ws_[A-Za-z0-9_-]+|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
  )?.[1]
  if (prefixed) return asWorkspaceId(prefixed)
  const ref = isWorkspaceIdRef(input) ? input?.trim() : undefined
  return ref ? asWorkspaceId(ref) : undefined
}

export function usesScopedSessionTransport(sessionID: string | undefined, directory?: string) {
  return (
    !!sessionID &&
    (requiresSignedLegacyDirectory(directory) || !sessionID.startsWith("ses") || !!workspaceIdFromRef(directory))
  )
}

export function isUserHostedWorkspaceDirectory(input: string | undefined) {
  if (!input) return false
  return /(?:^|[/\\])\.claxedo[/\\]user-hosted[/\\]workspaces[/\\][^/\\]+/.test(input)
}

export function requiresSignedLegacyDirectory(input: string | undefined) {
  return isFilesystemDirectory(input) || isUserHostedWorkspaceDirectory(input)
}

export function isLocalSessionDirectory(input: string | undefined): input is string {
  if (!input) return false
  if (requiresSignedLegacyDirectory(input)) return true
  return !input.startsWith("workspace:")
}

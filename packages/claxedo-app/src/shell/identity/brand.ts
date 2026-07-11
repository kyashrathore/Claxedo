// WP-D5 — nominal branded identifiers for the two "workspace" senses.
//
// These are zero-runtime-cost compile-time brands: a `DirectoryRef` / `WorkspaceId`
// is still a plain `string` at runtime (the brand is erased), so wire shapes and
// route params are byte-identical before and after branding. What the brands buy
// is that the *compiler* rejects assigning a directory path where a control-plane
// id is expected (and vice versa) — the sense-1/sense-2 conflation the app has
// carried (see `VOCABULARY.md` "the five senses of workspace").
//
// Because a brand is `string & {…}`, every branded value is assignable *into* a
// plain `string` slot (widening is free); only the reverse — minting a brand from
// an unbranded `string` — is restricted. The single legal mint sites are the
// legacy-string sniffers in `legacy-resolver.ts` and the route parser in
// `route.ts` (route params). Everywhere else the brand is *received*, never made.

/** Shared nominal-brand utility (promoted out of `shell/data/keys.ts`). */
export type Brand<T, Name extends string> = T & { readonly __scope: Name }

/** Sense 1 — a filesystem directory path. NEVER a control-plane id. */
export type DirectoryRef = Brand<string, "DirectoryRef">

/** Sense 2 — an opaque control-plane workspace id. NEVER a directory path. */
export type WorkspaceId = Brand<string, "WorkspaceId">

/**
 * Mint a `DirectoryRef` from a raw string. Restricted to the legacy-string owner
 * (`legacy-resolver.ts`), the route parser (`route.ts`), and directory decoders.
 * New call sites outside those owners are debt — receive the brand instead.
 */
export function asDirectoryRef(value: string): DirectoryRef {
  return value as DirectoryRef
}

/**
 * Mint a `WorkspaceId` from a raw string. Restricted to the workspace-id sniffers
 * in `legacy-resolver.ts` and the `/w/:workspaceId` route param in `route.ts`.
 */
export function asWorkspaceId(value: string): WorkspaceId {
  return value as WorkspaceId
}

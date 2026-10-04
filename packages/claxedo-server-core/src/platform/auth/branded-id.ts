/**
 * Branded control-plane identifiers, and the only places they are minted.
 *
 * `orgs.org_id` and `projects.project_id` are both `TEXT`, so nothing but a
 * type distinguishes them once they leave storage. The brands below make that
 * distinction real to the compiler: an `OrgId` cannot be passed where a
 * `ProjectId` is expected, and neither accepts a bare `string`.
 *
 * A brand exists only in the type system. There is no runtime shape to check,
 * so minting one is an assertion by construction — no predicate could honestly
 * confirm it, and one that returned `true` would only launder the same claim
 * into a form the type checker cannot question. The assertions are therefore
 * spelled once each, here, beside the brands they produce, instead of at every
 * adapter that reads the column. Callers reach for a mint; they never assert.
 *
 * This file is the whole of that concession: it is the only place in the
 * repository where `typescript/no-unsafe-type-assertion` is turned off, scoped
 * to this exact path in `.oxlintrc.json`, precisely because minting is all it
 * does. Anything that needs more than a brand belongs elsewhere.
 */

type BrandedString<T extends string> = string & { readonly __brand: T }

export type OrgId = BrandedString<"OrgId">
export type ProjectId = BrandedString<"ProjectId">
export type WorkspaceId = BrandedString<"WorkspaceId">

/** The one place a stored identifier becomes a branded `OrgId`. */
export function asOrgId(value: string): OrgId {
  return value as OrgId
}

/** The one place a stored identifier becomes a branded `ProjectId`. */
export function asProjectId(value: string): ProjectId {
  return value as ProjectId
}

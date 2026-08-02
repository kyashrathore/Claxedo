/**
 * W6.3 — shared Clerk-mirror helpers.
 *
 * These live in their own module rather than in `orgs.ts` or `clerkReconcile.ts`
 * because BOTH need them and the dependency has to run one way: `orgs.ts` is
 * the webhook applier and `clerkReconcile.ts` is the sweep, and the sweep
 * already imports `orgs`-adjacent helpers from `model.ts`. Putting the tombstone
 * reader in either one would make the pair circular.
 *
 * Exports no Convex functions on purpose — this is a helper module, so the D8
 * builder guard has nothing to check here.
 */

type Db = { query: (table: string) => any }

/**
 * Clerk's role string → this repo's org role.
 *
 * Lifted verbatim from `orgs.ts`'s private `clerkRole` so the sweep and the
 * webhook cannot disagree about what `org:admin` means. A second copy would be
 * a silent divergence the moment either side learned a new Clerk role — and
 * that divergence would present as the sweep "correcting" every admin to member
 * on every run, i.e. mass privilege removal.
 *
 * The substring test is Clerk's own shape: roles arrive as `org:admin` /
 * `org:member` (and historically bare `admin`/`member`), so matching on
 * "contains admin" covers both spellings without enumerating them.
 */
export function clerkRoleFor(input: unknown) {
  const value = typeof input === "string" ? input : ""
  if (value.includes("admin")) return "admin" as const
  return "member" as const
}

/**
 * The tombstone for one (org, user) pair, or undefined.
 *
 * Keyed on Clerk ids because the tombstone must be readable on the delete path
 * even when the Convex org/user rows do not resolve, and because a record whose
 * whole purpose is outliving a deleted row cannot be keyed on that row.
 */
export async function orgMembershipTombstone(db: Db, clerkOrgId: string, clerkSubject: string) {
  return await db
    .query("clerk_membership_tombstones")
    .withIndex("by_membership", (q: any) => q.eq("clerk_org_id", clerkOrgId).eq("clerk_subject", clerkSubject))
    .unique()
}

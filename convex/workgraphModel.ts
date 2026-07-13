import { readUser, requireControlPlaneService } from "./model"

export async function workGraphOwnerDeletionBarrier(
  ctx: { db: Parameters<typeof readUser>[0]["db"] },
  ownerUserId: unknown,
) {
  return ctx.db.query("workgraph_owner_deletion_barriers")
    .withIndex("by_owner", (query) => query.eq("owner_user_id", ownerUserId))
    .unique()
}

export async function assertWorkGraphOwnerWritable(
  ctx: { db: Parameters<typeof readUser>[0]["db"] },
  ownerUserId: unknown,
) {
  if (await workGraphOwnerDeletionBarrier(ctx, ownerUserId)) {
    throw new Error("WorkGraph owner deletion is in progress")
  }
}

export async function assertWorkGraphOwnerReadable(
  ctx: { db: Parameters<typeof readUser>[0]["db"] },
  ownerUserId: unknown,
) {
  if (await workGraphOwnerDeletionBarrier(ctx, ownerUserId)) {
    throw new Error("WorkGraph owner deletion is in progress")
  }
}

/**
 * Resolves the signed Convex identity to its durable user row and derives the
 * only personal owner scope an interactive handler may query or mutate.
 */
export async function requireOwnedWorkGraphContext(
  ctx: Parameters<typeof readUser>[0],
) {
  const user = await readUser(ctx)
  return { owner_user_id: user._id, user }
}

/**
 * Worker/reconciler entrypoints already use serviceQuery/serviceMutation. This
 * helper keeps their explicit owner scope fail-closed at the same service-token
 * boundary and returns only a normalized owner identifier, never credentials.
 */
export function requireTrustedWorkGraphOwner(serviceToken: string, ownerUserId: string) {
  requireControlPlaneService(serviceToken)
  const owner = ownerUserId.trim()
  if (!owner) throw new Error("Invalid WorkGraph owner")
  return owner
}

/** Resolve a verified external subject to the durable Convex user id. */
export async function requireTrustedWorkGraphOwnerSubject(ctx: Parameters<typeof readUser>[0], serviceToken: string, ownerSubject: string) {
  requireControlPlaneService(serviceToken)
  const subject = ownerSubject.trim()
  if (!subject) throw new Error("Invalid WorkGraph owner subject")
  const user = await ctx.db.query("users").withIndex("by_clerk_subject", (query) => query.eq("clerk_subject", subject)).unique()
  if (!user) throw new Error("WorkGraph owner not found")
  return user
}

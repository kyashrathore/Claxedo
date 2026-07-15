import { readUser, requireControlPlaneService } from "./model"
import type { GenericDatabaseReader, GenericDatabaseWriter } from "convex/server"
import type { DataModel, Id } from "./_generated/dataModel"

type WorkGraphDb = GenericDatabaseReader<DataModel> | GenericDatabaseWriter<DataModel>

export async function workGraphOwnerDeletionBarrier(
  ctx: { db: WorkGraphDb },
  organizationId: unknown,
  ownerUserId: unknown,
) {
  return ctx.db.query("workgraph_owner_deletion_barriers")
    .withIndex("by_tenant", (query) => query.eq("organization_id", organizationId as Id<"orgs">).eq("owner_user_id", ownerUserId as Id<"users">))
    .unique()
}

export async function assertWorkGraphOwnerWritable(
  ctx: { db: WorkGraphDb },
  organizationId: unknown,
  ownerUserId: unknown,
) {
  if (await workGraphOwnerDeletionBarrier(ctx, organizationId, ownerUserId)) {
    throw new Error("WorkGraph owner deletion is in progress")
  }
}

export async function assertWorkGraphOwnerReadable(
  ctx: { db: WorkGraphDb },
  organizationId: unknown,
  ownerUserId: unknown,
) {
  if (await workGraphOwnerDeletionBarrier(ctx, organizationId, ownerUserId)) {
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

/** Resolve and verify the exact durable organization + user WorkGraph tenant. */
export async function requireTrustedWorkGraphTenantSubject(
  ctx: Parameters<typeof readUser>[0],
  serviceToken: string,
  organizationId: unknown,
  ownerSubject: string,
) {
  const user = await requireTrustedWorkGraphOwnerSubject(ctx, serviceToken, ownerSubject)
  if (!organizationId) throw new Error("WorkGraph organization is required")
  const organization = await ctx.db.get(organizationId as never)
  if (!organization || organization._id !== organizationId) throw new Error("WorkGraph organization not found")
  const membership = await ctx.db.query("org_memberships")
    .withIndex("by_org_user", (query) => query.eq("org_id", organizationId))
    .filter((query) => query.eq(query.field("user_id"), user._id))
    .unique()
  if (!membership) throw new Error("WorkGraph organization membership is required")
  return { organization_id: organizationId, owner_user_id: user._id, user, organization }
}

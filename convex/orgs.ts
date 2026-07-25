import { v } from "convex/values"
import { authedMutation, authedQuery, orgByClerkOrgId, readUser, serviceQuery, upsertUser, userByClerkSubject, webhookMutation } from "./model"

export async function personalOrgForUser(ctx: any, user: { _id: unknown; name?: string; email?: string }) {
  const existing = (await ctx.db
    .query("orgs")
    .withIndex("by_owner", (q: any) => q.eq("owner_user_id", user._id))
    .collect())
    .find((org: any) => org.kind === "personal" && !org.clerk_org_id && !org.deleted_at)
  if (existing) return existing
  const now = Date.now()
  const orgId = await ctx.db.insert("orgs", {
    name: user.name ?? user.email ?? "Personal",
    kind: "personal",
    owner_user_id: user._id,
    created_at: now,
    updated_at: now,
  })
  await ctx.db.insert("org_memberships", {
    org_id: orgId,
    user_id: user._id,
    role: "owner",
    created_at: now,
    updated_at: now,
  })
  return await ctx.db.get(orgId)
}

export const listForMe = authedQuery({
  args: {},
  handler: async (ctx) => {
    const user = await readUser(ctx)
    const memberships = await ctx.db
      .query("org_memberships")
      .withIndex("by_user", (q) => q.eq("user_id", user._id))
      .collect()

    return await Promise.all(memberships.map(async (membership) => {
      const org = await ctx.db.get(membership.org_id)
      return org ? {
        org_id: org._id,
        clerk_org_id: org.clerk_org_id,
        slug: org.slug,
        name: org.name,
        role: membership.role,
      } : undefined
    })).then((items) => items.filter((item) => item !== undefined))
  },
})

export const ensurePersonalOrg = authedMutation({
  args: {},
  handler: async (ctx) => {
    const user = await upsertUser(ctx)
    const org = await personalOrgForUser(ctx, user)
    return {
      org_id: org._id,
      clerk_org_id: org.clerk_org_id,
      role: "owner",
    }
  },
})

export const resolveForMe = authedMutation({
  args: {
    clerk_org_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await upsertUser(ctx)
    if (args.clerk_org_id) {
      const org = await orgByClerkOrgId(ctx.db, args.clerk_org_id)
      if (!org || org.deleted_at) throw new Error("Organization not found")
      const membership = (await ctx.db
        .query("org_memberships")
        .withIndex("by_org_user", (q: any) => q.eq("org_id", org._id))
        .collect())
        .find((item: any) => item.user_id === user._id)
      if (membership) return { org_id: org._id, clerk_org_id: org.clerk_org_id, role: membership.role }
      throw new Error("Organization membership is required")
    }
    const personal = await personalOrgForUser(ctx, user)
    return { org_id: personal._id, clerk_org_id: personal.clerk_org_id, role: "owner" }
  },
})

export const setActive = authedQuery({
  args: {
    clerk_org_id: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await readUser(ctx)
    const orgs = await ctx.db.query("orgs").collect()
    const org = orgs.find((item) => item.clerk_org_id === args.clerk_org_id)
    if (!org) throw new Error("Org not found")
    const memberships = await ctx.db
      .query("org_memberships")
      .withIndex("by_org_user", (q) => q.eq("org_id", org._id))
      .collect()
    const membership = memberships.find((item) => item.user_id === user._id)
    if (!membership) throw new Error("Org not found")
    return {
      org_id: org._id,
      clerk_org_id: org.clerk_org_id,
      role: membership.role,
    }
  },
})

function clerkRole(input: unknown) {
  const value = typeof input === "string" ? input : ""
  if (value.includes("admin")) return "admin"
  return "member"
}

function eventTime(data: Record<string, any>) {
  const value = data.updated_at ?? data.created_at
  return typeof value === "number" ? value : Date.now()
}

async function upsertClerkUser(ctx: any, data: Record<string, any>) {
  const subject = typeof data.id === "string" ? data.id : undefined
  if (!subject) return
  const existing = await ctx.db
    .query("users")
    .withIndex("by_clerk_subject", (q: any) => q.eq("clerk_subject", subject))
    .unique()
  const now = Date.now()
  const patch = {
    clerk_subject: subject,
    email: data.email_addresses?.[0]?.email_address,
    name: [data.first_name, data.last_name].filter(Boolean).join(" ") || undefined,
    image_url: data.image_url,
    updated_at: now,
  }
  if (existing) {
    await ctx.db.patch(existing._id, patch)
    return existing._id
  }
  return await ctx.db.insert("users", {
    token_identifier: `clerk:${subject}`,
    issuer: "clerk",
    kind: "human",
    ...patch,
    created_at: now,
  })
}

async function upsertClerkOrg(ctx: any, data: Record<string, any>) {
  const clerkOrgId = typeof data.id === "string" ? data.id : undefined
  if (!clerkOrgId) return
  const existing = await orgByClerkOrgId(ctx.db, clerkOrgId)
  const updatedAt = eventTime(data)
  if (existing?.clerk_updated_at && existing.clerk_updated_at > updatedAt) return existing._id
  const patch = {
    clerk_org_id: clerkOrgId,
    slug: data.slug,
    name: data.name ?? data.slug ?? clerkOrgId,
    kind: "clerk" as const,
    deleted_at: undefined,
    clerk_updated_at: updatedAt,
    updated_at: Date.now(),
  }
  if (existing) {
    await ctx.db.patch(existing._id, patch)
    return existing._id
  }
  return await ctx.db.insert("orgs", {
    ...patch,
    created_at: Date.now(),
  })
}

async function upsertClerkMembership(ctx: any, data: Record<string, any>) {
  const orgId = await upsertClerkOrg(ctx, data.organization ?? {})
  const clerkSubject = data.public_user_data?.user_id ?? data.user_id
  if (!orgId || typeof clerkSubject !== "string") return
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_subject", (q: any) => q.eq("clerk_subject", clerkSubject))
    .unique()
  if (!user) return
  const updatedAt = eventTime(data)
  const existing = (await ctx.db
    .query("org_memberships")
    .withIndex("by_org_user", (q: any) => q.eq("org_id", orgId))
    .collect())
    .find((membership: any) => membership.user_id === user._id)
  if (existing?.clerk_updated_at && existing.clerk_updated_at > updatedAt) return
  const patch = {
    role: clerkRole(data.role),
    clerk_updated_at: updatedAt,
    updated_at: Date.now(),
  }
  if (existing) {
    await ctx.db.patch(existing._id, patch)
    return
  }
  // F1 (adversarial review): the seat hard-block used to throw here, inside the
  // Svix-verified Clerk→Convex mirror. That was the WRONG layer: the member
  // already exists in Clerk by the time this runs (so the throw cannot block
  // the join), and throwing 500s the whole Svix delivery — wedging the entire
  // mirror, including membership REVOCATIONS. The mirror must never 500 on seat
  // count. Seat enforcement now lives at the entitlement/capability layer
  // (src/billing/entitlement.ts: an org OVER its licensed seats is denied
  // hosted "cloud-workspace"/"hosted-connections" access), and Clerk's
  // membership count here is treated as advisory — it always syncs cleanly.
  await ctx.db.insert("org_memberships", {
    org_id: orgId,
    user_id: user._id,
    ...patch,
    created_at: Date.now(),
  })
}

async function deleteClerkMembership(ctx: any, data: Record<string, any>) {
  const clerkOrgId = data.organization?.id
  const clerkSubject = data.public_user_data?.user_id ?? data.user_id
  if (typeof clerkOrgId !== "string" || typeof clerkSubject !== "string") return
  const org = await orgByClerkOrgId(ctx.db, clerkOrgId)
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_subject", (q: any) => q.eq("clerk_subject", clerkSubject))
    .unique()
  if (!org || !user) return
  const membership = (await ctx.db
    .query("org_memberships")
    .withIndex("by_org_user", (q: any) => q.eq("org_id", org._id))
    .collect())
    .find((item: any) => item.user_id === user._id)
  if (membership) await ctx.db.delete(membership._id)
}

// Applier for the Svix-verified Clerk webhook http action (convex/http.ts),
// which invokes it via `ctx.runMutation`.
//
// INTERNAL, never public. The Svix signature check lives in the httpAction, so
// a public applier is a second, unauthenticated door into the same authority
// with the signature check skipped. As a `publicMutation` this was directly
// callable by any Convex client holding the deployment URL (public: it ships in
// the app bundle as `VITE_CONVEX_URL`), and `organizationMembership.created`
// let the caller mint themselves an `org:admin` membership in an arbitrary org
// — which `directOrgRole` resolves to admin on every workspace in that org.
// `webhookMutation` gives it internal visibility — callable ONLY from inside
// the deployment. `ctx.runMutation` in http.ts is unaffected because it resolves
// by UDF path, not visibility.
export const applyClerkWebhook = webhookMutation({
  args: {
    type: v.string(),
    data: v.any(),
  },
  handler: async (ctx, args) => {
    const data = args.data as Record<string, any>
    if (args.type === "user.created") await upsertClerkUser(ctx, data)
    if (args.type === "organization.created" || args.type === "organization.updated") await upsertClerkOrg(ctx, data)
    if (args.type === "organizationMembership.created" || args.type === "organizationMembership.updated") await upsertClerkMembership(ctx, data)
    if (args.type === "organizationMembership.deleted") await deleteClerkMembership(ctx, data)
    if (args.type === "organization.deleted") {
      const org = typeof data.id === "string" ? await orgByClerkOrgId(ctx.db, data.id) : undefined
      if (org) await ctx.db.patch(org._id, { deleted_at: Date.now(), updated_at: Date.now() })
    }
    return { ok: true }
  },
})

/**
 * F12 (adversarial review): membership re-check for the hosted connections gate
 * (src/connections-host/connections-host.ts). The connections host derives the
 * team partition from the caller's verified Clerk `org_id` claim; D2 says JWT
 * org claims must not be the sole authorization input, so the host re-checks
 * that the subject is ACTUALLY a member of that org in Convex before granting
 * the team partition. Service-token gated (machine principal — the Worker/host,
 * which holds no end-user identity for the connections turn). Returns a plain
 * membership verdict; a stale/mis-synced claim with no backing membership row
 * resolves to `{ member: false }` and the host answers 403.
 */
export const membershipByClerkIds = serviceQuery({
  args: {
    clerk_org_id: v.string(),
    clerk_subject: v.string(),
  },
  handler: async (ctx, args) => {
    const org = await orgByClerkOrgId(ctx.db, args.clerk_org_id)
    if (!org || org.deleted_at) return { member: false as const }
    const user = await userByClerkSubject(ctx.db, args.clerk_subject)
    if (!user) return { member: false as const }
    const memberships = await ctx.db
      .query("org_memberships")
      .withIndex("by_org_user", (q: any) => q.eq("org_id", org._id))
      .collect()
    const membership = memberships.find((item: any) => item.user_id === user._id)
    return membership
      ? { member: true as const, org_id: String(org._id), user_id: String(user._id), role: membership.role as string }
      : { member: false as const }
  },
})

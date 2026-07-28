import {
  internalMutationGeneric,
  mutationGeneric,
  queryGeneric,
  type GenericDatabaseReader,
  type GenericDatabaseWriter,
  type GenericMutationCtx,
  type GenericQueryCtx,
} from "convex/server"
import { v, type ObjectType, type PropertyValidators } from "convex/values"

type Db = GenericDatabaseReader<any> | GenericDatabaseWriter<any>
type IdentityCtx = {
  auth: {
    getUserIdentity(): Promise<{
      tokenIdentifier: string
      subject?: string
      issuer?: string
      email?: string
      name?: string
      pictureUrl?: string
    } | null>
  }
}

export type WorkspaceAction = "read" | "write" | "admin" | "owner"
export type WorkspaceRole = "viewer" | "editor" | "admin" | "owner"
type OrgRole = "member" | "admin" | "owner"
const roleRank: Record<WorkspaceRole, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
  owner: 4,
}

function clerkIssuer() {
  return process.env.CLERK_JWT_ISSUER_DOMAIN ?? process.env.CLERK_JWT_ISSUER
}

export function roleAllows(role: WorkspaceRole, action: WorkspaceAction) {
  if (role === "owner") return true
  if (role === "admin") return action !== "owner"
  if (role === "editor") return action === "read" || action === "write"
  return action === "read"
}

export function maxRole(roles: Array<WorkspaceRole | undefined>) {
  return roles.filter((role): role is WorkspaceRole => !!role)
    .sort((a, b) => roleRank[b] - roleRank[a])[0]
}

export function combineRolePrecedence(input: {
  owner?: boolean
  directWorkspace?: WorkspaceRole
  directProject?: WorkspaceRole
  directOrg?: WorkspaceRole
  share?: WorkspaceRole
  orgShare?: WorkspaceRole
}) {
  if (input.owner) return "owner"
  return maxRole([
    input.directWorkspace,
    input.directProject,
    input.directOrg,
    input.share,
    input.orgShare,
  ])
}

export async function requireIdentity(ctx: IdentityCtx) {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) throw new Error("Unauthenticated")
  const issuer = clerkIssuer()
  if (issuer && identity.issuer !== issuer) throw new Error("Wrong issuer")
  return identity
}

export async function readUser(ctx: { db: Db } & IdentityCtx) {
  const identity = await requireIdentity(ctx)
  const user = await ctx.db
    .query("users")
    .withIndex("by_token_identifier", (q) => q.eq("token_identifier", identity.tokenIdentifier))
    .unique()
  if (!user) throw new Error("User not found")
  return user
}

export async function upsertUser(ctx: { db: GenericDatabaseWriter<any> } & IdentityCtx) {
  const identity = await requireIdentity(ctx)
  const now = Date.now()
  const existing = await ctx.db
    .query("users")
    .withIndex("by_token_identifier", (q) => q.eq("token_identifier", identity.tokenIdentifier))
    .unique()
  const patch = {
    clerk_subject: identity.subject,
    issuer: identity.issuer,
    email: identity.email,
    name: identity.name,
    image_url: identity.pictureUrl,
    kind: "human" as const,
    updated_at: now,
  }
  if (existing) {
    await ctx.db.patch(existing._id, patch)
    return { ...existing, ...patch }
  }
  const user = {
    token_identifier: identity.tokenIdentifier,
    ...patch,
    created_at: now,
  }
  return {
    _id: await ctx.db.insert("users", user),
    ...user,
  }
}

export async function upsertServiceUser(ctx: { db: GenericDatabaseWriter<any> }, input: {
  token_identifier: string
  subject?: string
  issuer?: string
  email?: string
  name?: string
  image_url?: string
}) {
  const now = Date.now()
  const existing = await ctx.db
    .query("users")
    .withIndex("by_token_identifier", (q) => q.eq("token_identifier", input.token_identifier))
    .unique()
  const patch = {
    clerk_subject: input.subject,
    issuer: input.issuer,
    email: input.email,
    name: input.name,
    image_url: input.image_url,
    kind: "agent" as const,
    updated_at: now,
  }
  if (existing) {
    await ctx.db.patch(existing._id, patch)
    return { ...existing, ...patch }
  }
  const user = {
    token_identifier: input.token_identifier,
    ...patch,
    created_at: now,
  }
  return {
    _id: await ctx.db.insert("users", user),
    ...user,
  }
}

async function directWorkspaceRole(db: Db, userId: unknown, workspaceId: unknown) {
  const memberships = await db
    .query("workspace_memberships")
    .withIndex("by_workspace_user", (q) => q.eq("workspace_id", workspaceId))
    .collect()
  const membership = memberships.find((item) => item.user_id === userId)
  return typeof membership?.role === "string" ? membership.role as WorkspaceRole : undefined
}

async function directProjectRole(db: Db, userId: unknown, projectId: unknown) {
  const memberships = await db
    .query("project_memberships")
    .withIndex("by_project_user", (q) => q.eq("project_id", projectId))
    .collect()
  const membership = memberships.find((item) => item.user_id === userId)
  return typeof membership?.role === "string" ? membership.role as WorkspaceRole : undefined
}

async function shareRole(db: Db, userId: unknown, workspaceId: unknown) {
  const grants = await db
    .query("workspace_share_grants")
    .withIndex("by_user", (q) => q.eq("granted_to_user_id", userId))
    .collect()
  const grant = grants.find((item) => item.workspace_id === workspaceId && !item.revoked_at)
  return typeof grant?.role === "string" ? grant.role as WorkspaceRole : undefined
}

function orgWorkspaceRole(role: OrgRole) {
  if (role === "owner" || role === "admin") return "admin"
  return "viewer"
}

async function directOrgRole(db: Db, userId: unknown, orgId: unknown) {
  const org = await db.get(orgId as never)
  if (org?.deleted_at) return
  const memberships = await db
    .query("org_memberships")
    .withIndex("by_org_user", (q) => q.eq("org_id", orgId))
    .collect()
  const membership = memberships.find((item) => item.user_id === userId)
  return typeof membership?.role === "string" ? orgWorkspaceRole(membership.role as OrgRole) : undefined
}

async function orgShareRole(db: Db, userId: unknown, workspaceId: unknown) {
  const memberships = await db
    .query("org_memberships")
    .withIndex("by_user", (q) => q.eq("user_id", userId))
    .collect()
  const grants = (await Promise.all(memberships.map(async (membership) => {
    return await db
      .query("workspace_share_grants")
      .withIndex("by_org", (q) => q.eq("granted_to_org_id", membership.org_id))
      .collect()
  }))).flat()
  const grant = grants.find((item) => item.workspace_id === workspaceId && !item.revoked_at)
  return typeof grant?.role === "string" ? grant.role as WorkspaceRole : undefined
}

export async function workspaceRoleForUser(ctx: { db: Db }, workspace: Record<string, unknown>, user: { _id: unknown }) {
  if (workspace.deleted_at) return
  const project = typeof workspace.project_id === "string"
    ? await projectByPublicId(ctx.db, workspace.project_id)
    : undefined
  return combineRolePrecedence({
    owner: workspace.owner_user_id === user._id,
    directWorkspace: await directWorkspaceRole(ctx.db, user._id, workspace._id),
    directProject: project ? await directProjectRole(ctx.db, user._id, project._id) : undefined,
    directOrg: workspace.org_id ? await directOrgRole(ctx.db, user._id, workspace.org_id) : undefined,
    share: await shareRole(ctx.db, user._id, workspace._id),
    orgShare: await orgShareRole(ctx.db, user._id, workspace._id),
  })
}

export async function workspaceRole(ctx: { db: Db } & IdentityCtx, workspace: Record<string, unknown>) {
  return workspaceRoleForUser(ctx, workspace, await readUser(ctx))
}

export async function projectRoleForUser(ctx: { db: Db }, project: Record<string, unknown>, user: { _id: unknown }) {
  if (project.deleted_at) return
  return combineRolePrecedence({
    owner: project.owner_user_id === user._id,
    directProject: await directProjectRole(ctx.db, user._id, project._id),
    directOrg: await directOrgRole(ctx.db, user._id, project.org_id),
  })
}

export async function projectRole(ctx: { db: Db } & IdentityCtx, project: Record<string, unknown>) {
  return projectRoleForUser(ctx, project, await readUser(ctx))
}

export async function authorizeProject(ctx: { db: Db } & IdentityCtx, project: Record<string, unknown>, action: WorkspaceAction) {
  const role = await projectRole(ctx, project)
  return role && roleAllows(role, action) ? role : undefined
}

export async function authorizeProjectForUser(ctx: { db: Db }, project: Record<string, unknown>, user: { _id: unknown }, action: WorkspaceAction) {
  const role = await projectRoleForUser(ctx, project, user)
  return role && roleAllows(role, action) ? role : undefined
}

export async function authorizeWorkspace(ctx: { db: Db } & IdentityCtx, workspace: Record<string, unknown>, action: WorkspaceAction) {
  const role = await workspaceRole(ctx, workspace)
  return role && roleAllows(role, action) ? role : undefined
}

export async function authorizeWorkspaceForUser(ctx: { db: Db }, workspace: Record<string, unknown>, user: { _id: unknown }, action: WorkspaceAction) {
  const role = await workspaceRoleForUser(ctx, workspace, user)
  return role && roleAllows(role, action) ? role : undefined
}

export async function workspaceByPublicId(db: Db, workspaceId: string) {
  return await db
    .query("workspaces")
    .withIndex("by_workspace_id", (q) => q.eq("workspace_id", workspaceId))
    .unique()
}

export async function projectByPublicId(db: Db, projectId: string) {
  return await db
    .query("projects")
    .withIndex("by_project_id", (q) => q.eq("project_id", projectId))
    .unique()
}

export async function orgByClerkOrgId(db: Db, clerkOrgId: string) {
  return await db
    .query("orgs")
    .withIndex("by_clerk_org_id", (q) => q.eq("clerk_org_id", clerkOrgId))
    .unique()
}

export async function userByTokenIdentifier(db: Db, tokenIdentifier: string) {
  return await db
    .query("users")
    .withIndex("by_token_identifier", (q) => q.eq("token_identifier", tokenIdentifier))
    .unique()
}

export async function userByClerkSubject(db: Db, clerkSubject: string) {
  return await db
    .query("users")
    .withIndex("by_clerk_subject", (q) => q.eq("clerk_subject", clerkSubject))
    .unique()
}

// ---------------------------------------------------------------------------
// Mandatory function builders (D8).
//
// Every exported Convex function MUST be built from one of these — never from
// raw `queryGeneric`/`mutationGeneric`. The architecture guard in
// `packages/claxedo-server/src/control-plane/convex-authz-guard.test.ts`
// ratchets raw builder usage outside this module to zero.
//
// - `authedQuery`/`authedMutation`: a verified end-user identity is resolved
//   BEFORE the handler runs (same `requireIdentity` semantics the handlers
//   used inline); the handler receives it as `ctx.identity`. User-row
//   resolution (`readUser` vs `upsertUser`) intentionally stays inside each
//   handler because read-vs-upsert is per-function write behavior.
// - `serviceQuery`/`serviceMutation`: a verified machine principal. The
//   builder appends a required `service_token` arg and validates it against
//   the deployment-held `CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN` secret — the
//   exact calling convention of the control-plane executor
//   (`packages/claxedo-server/src/control-plane/adapters/convex/`).
// - `publicQuery`/`publicMutation`: explicitly unauthenticated. Adding one is
//   a reviewed decision, not a default. There are currently ZERO callers, and
//   that is the intended steady state — see `webhookMutation` below for why the
//   last one was removed.
// - `cronMutation`: a deployment-internal function for `convex/crons.ts`
//   handlers (D13 reaper). Internal visibility means it is NOT callable by any
//   client at all — only the Convex scheduler/crons — which is a strictly
//   stronger stance than a service token, and the reason the guard permits
//   `internalMutationGeneric` here.
// - `webhookMutation`: the appliers invoked by a signature-verified webhook
//   httpAction in `convex/http.ts` via `ctx.runMutation`. Same internal
//   visibility as `cronMutation`, for the same reason.
//
//   This exists because building such an applier from `publicMutation` is a
//   privilege-escalation hole, not a style problem: the signature check lives
//   in the httpAction, so a PUBLIC applier is separately callable by any
//   unauthenticated Convex client with the deployment URL (which ships in the
//   web/desktop bundle as `VITE_CONVEX_URL`) — handing the caller the webhook's
//   authority with the signature check skipped entirely. `orgs.applyClerkWebhook`
//   was reachable this way and let any signed-up user mint themselves an
//   `org:admin` membership in ANY org, which `directOrgRole` then resolves to
//   admin on every workspace in that org. Webhook appliers MUST be internal.
// ---------------------------------------------------------------------------

type Identity = NonNullable<Awaited<ReturnType<IdentityCtx["auth"]["getUserIdentity"]>>>
// Mirrors what raw `queryGeneric`/`mutationGeneric` provide: they are
// `QueryBuilder<any, "public">`, i.e. document types are `any`.
type QueryCtx = GenericQueryCtx<any>
type MutationCtx = GenericMutationCtx<any>

// F4 (pre-launch security review): the service token is a shared secret held on
// BOTH sides — set as a Convex deployment env var here, and as a Worker secret
// in packages/claxedo-server. Those two swaps cannot be made atomic, so with a
// single accepted value ANY rotation guarantees an outage window: for the
// duration of the skew every serviceQuery/serviceMutation in convex/ throws
// "Unauthenticated", which is the entire control-plane executor surface plus
// the wakes settlement dispatcher. That made the secret effectively
// unrotatable — the worst property for a credential to have, because it turns
// "we should rotate" into "we can't afford to".
//
// Accepting a PREVIOUS value alongside the current one makes rotation ordered
// and zero-downtime:
//   1. set _PREVIOUS to the live token (both sides now accept it, nothing changes)
//   2. set the new token on Convex, then on the Worker (skew is covered by _PREVIOUS)
//   3. clear _PREVIOUS once the Worker is fully rolled
// Only step 3 narrows the accepted set, and by then nothing is signing with the
// old value. Both slots are compared timing-safely and an empty/whitespace
// _PREVIOUS is ignored, so the steady state (unset) is exactly as strict as before.
function controlPlaneServiceTokens() {
  return [
    process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN?.trim(),
    process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN_PREVIOUS?.trim(),
  ].filter((value): value is string => !!value)
}

// Constant-time string compare — the service token is a shared secret, so
// match the timing-safe posture the webhook/web-crypto verifiers use rather
// than a short-circuiting `!==` (F15). Self-contained because the convex
// bundle cannot import from packages/claxedo-server.
function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i % b.length)
  }
  return diff === 0
}

export function requireControlPlaneService(token: string) {
  const accepted = controlPlaneServiceTokens()
  // No configured token accepts NOTHING (fail closed) — never "no secret set,
  // so allow". `reduce` rather than `some` so every candidate is compared and
  // the work does not short-circuit on the first match, preserving the
  // timing-safe posture across the two slots.
  const matched = accepted.reduce((found, expected) => timingSafeEqual(token, expected) || found, false)
  if (!matched) throw new Error("Unauthenticated")
}

export function authedQuery<Args extends PropertyValidators, Output>(spec: {
  args: Args
  handler: (ctx: QueryCtx & { identity: Identity }, args: ObjectType<Args>) => Output
}) {
  return queryGeneric({
    args: spec.args,
    handler: async (ctx, args: any) => {
      const identity: Identity = await requireIdentity(ctx)
      return spec.handler({ ...ctx, identity }, args)
    },
  })
}

export function authedMutation<Args extends PropertyValidators, Output>(spec: {
  args: Args
  handler: (ctx: MutationCtx & { identity: Identity }, args: ObjectType<Args>) => Output
}) {
  return mutationGeneric({
    args: spec.args,
    handler: async (ctx, args: any) => {
      const identity: Identity = await requireIdentity(ctx)
      return spec.handler({ ...ctx, identity }, args)
    },
  })
}

export function serviceQuery<Args extends PropertyValidators, Output>(spec: {
  args: Args
  handler: (ctx: QueryCtx, args: ObjectType<Args> & { service_token: string }) => Output
}) {
  return queryGeneric({
    args: { ...spec.args, service_token: v.string() },
    handler: async (ctx, args: any) => {
      requireControlPlaneService(args.service_token)
      return spec.handler(ctx, args)
    },
  })
}

export function serviceMutation<Args extends PropertyValidators, Output>(spec: {
  args: Args
  handler: (ctx: MutationCtx, args: ObjectType<Args> & { service_token: string }) => Output
}) {
  return mutationGeneric({
    args: { ...spec.args, service_token: v.string() },
    handler: async (ctx, args: any) => {
      requireControlPlaneService(args.service_token)
      return spec.handler(ctx, args)
    },
  })
}

export function cronMutation<Args extends PropertyValidators, Output>(spec: {
  args: Args
  handler: (ctx: MutationCtx, args: ObjectType<Args>) => Output
}) {
  return internalMutationGeneric(spec)
}

export function webhookMutation<Args extends PropertyValidators, Output>(spec: {
  args: Args
  handler: (ctx: MutationCtx, args: ObjectType<Args>) => Output
}) {
  return internalMutationGeneric(spec)
}

export function publicQuery<Args extends PropertyValidators, Output>(spec: {
  args: Args
  handler: (ctx: QueryCtx, args: ObjectType<Args>) => Output
}) {
  return queryGeneric(spec)
}

export function publicMutation<Args extends PropertyValidators, Output>(spec: {
  args: Args
  handler: (ctx: MutationCtx, args: ObjectType<Args>) => Output
}) {
  return mutationGeneric(spec)
}

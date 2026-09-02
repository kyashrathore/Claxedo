import { v } from "convex/values"
import {
  authedMutation,
  authedQuery,
  authorizeWorkspace,
  authorizeWorkspaceForUser,
  cronMutation,
  hostEnrollmentServesWorkspace,
  serviceMutation,
  serviceQuery,
  upsertServiceUser,
  upsertUser,
  userByTokenIdentifier,
  workspaceByPublicId,
} from "./model"
import { registerLocalForSharingAs } from "./workspaces"

/**
 * Machine-wide remote access.
 *
 * The retired per-workspace host-link module did these four things per
 * WORKSPACE. This does them per MACHINE, and every difference is the removal
 * of workspace handling: no ownership check against a workspace doc, no
 * cloud-workspace refusal, and — the one that matters — no implicit workspace
 * insert. Enrolling a laptop creates nothing to own.
 *
 * Workspaces re-enter at the ASSIGNMENT grain (`host_workspace_assignments`):
 * the owner's declaration that host H serves workspace X. An assignment
 * carries no liveness of its own — the enrollment lease answers "is the
 * machine here", the machine's consent set is acked by the heartbeat's v2
 * signature and stored on the enrollment doc, and routing requires all three.
 *
 * The hard cut removed the per-workspace module entirely — there is no
 * compatibility mode reading both, because two writers to one access decision
 * is how a session gets admitted while the other side believes it is paused.
 */

const DEFAULT_TTL_MS = 60_000
const MAX_TTL_MS = 5 * 60_000

/**
 * Machine-enrollment retention policy — ONE canonical set of bounds, mirrored
 * verbatim in the SQLite authority
 * (`packages/claxedo-server-core/src/authority/adapters/sqlite/workspace-authority.ts`),
 * whose header carries the full reasoning for each number. Kept as literals in
 * both files rather than imported from one, because a Convex function module is
 * deployed on its own and cannot reach into a workspace package;
 * `host-enrollment-policy-drift.test.ts` reads both sources and fails when a
 * value moves on one side only.
 *
 * The short version:
 *  - 60s challenge TTL, deliberately stricter than the plan's two minutes: the
 *    nonce is one-use, owner-bound and host-bound, and a lapsed one costs the
 *    client a free `createRequest` retry.
 *  - 10 minutes of consumed-evidence retention, which is what makes a future
 *    exact-retry answer reconstructable. The sweep must never collect a
 *    consumed row before that window closes.
 */
export const ENROLLMENT_CHALLENGE_TTL_MS = 60_000
export const ENROLLMENT_CONSUMED_RETENTION_MS = 10 * 60_000

/** Rows one sweep tick may retire. Bounds the transaction read set. */
export const ENROLLMENT_REQUEST_SWEEP_LIMIT = 500

const serviceUser = v.object({
  token_identifier: v.string(),
  subject: v.optional(v.string()),
  issuer: v.optional(v.string()),
  email: v.optional(v.string()),
  name: v.optional(v.string()),
  image_url: v.optional(v.string()),
})

function ttl(input?: number) {
  if (!input || !Number.isFinite(input)) return DEFAULT_TTL_MS
  return Math.max(5_000, Math.min(input, MAX_TTL_MS))
}

function base64url(bytes: Uint8Array) {
  let value = ""
  for (const byte of bytes) value += String.fromCharCode(byte)
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function base64urlBytes(input: string) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/")
  const value = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))
  return Uint8Array.from(value, (char) => char.charCodeAt(0))
}

/**
 * Signed payloads carry their own domain prefix.
 *
 * A signature captured from one flow must not be replayable in another, and
 * the domain prefix is what prevents it.
 */
function enrollmentPayload(input: { host_id: string; request_id: string; nonce: string }) {
  return [
    "claxedo.host-enrollment.enroll.v1",
    `host_id=${input.host_id}`,
    `request_id=${input.request_id}`,
    `nonce=${input.nonce}`,
  ].join("\n")
}

/**
 * Heartbeat v2: the machine's ONE signature per interval also covers the
 * workspaces it currently serves (sorted, comma-joined). Routing requires a
 * workspace to be BOTH owner-assigned and inside this acked set, which
 * preserves the retired per-workspace signature's security property — an
 * owner session cannot conjure serving the machine never consented to — at
 * one signature instead of N+1. Same literal as the D1 authority's
 * `hostEnrollmentHeartbeatPayloadV2` and the SQLite authority's builder:
 * three authorities, one signed contract.
 */
function heartbeatPayloadV2(input: { host_id: string; ttl_ms?: number; workspace_ids: readonly string[] }) {
  return [
    "claxedo.host-enrollment.heartbeat.v2",
    `host_id=${input.host_id}`,
    `ttl_ms=${input.ttl_ms ?? ""}`,
    `workspaces=${[...input.workspace_ids].sort().join(",")}`,
  ].join("\n")
}

/** A signed heartbeat payload must stay small; 200 shares per machine is generous. Mirrors the D1 authority. */
const MAX_ACKED_WORKSPACES = 200

async function verifyHostSignature(input: { public_key: string; payload: string; signature: string }) {
  const jwk = JSON.parse(input.public_key)
  if (jwk?.kty !== "EC" || jwk?.crv !== "P-256") throw new Error("Invalid host public key")
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
  if (
    !(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      base64urlBytes(input.signature),
      new TextEncoder().encode(input.payload),
    ))
  ) {
    throw new Error("Invalid host attestation")
  }
}

/** Row → what an owner may see. The public key never crosses this boundary. */
function toEnrollment(row: {
  enrollment_id: string
  host_id: string
  display_name?: string
  expires_at: number
  last_seen_at: number
  created_at: number
}) {
  return {
    enrollment_id: row.enrollment_id,
    host_id: row.host_id,
    ...(row.display_name ? { display_name: row.display_name } : {}),
    expires_at: row.expires_at,
    last_seen_at: row.last_seen_at,
    created_at: row.created_at,
  }
}

function enrollmentByOwnerHost(ctx: any, user: { _id: unknown }, host_id: string) {
  return ctx.db
    .query("host_enrollments")
    .withIndex("by_owner_host", (q: any) => q.eq("owner_user_id", user._id).eq("host_id", host_id))
    .unique()
}

function assignmentsByOwnerHost(ctx: any, user: { _id: unknown }, host_id: string) {
  return ctx.db
    .query("host_workspace_assignments")
    .withIndex("by_owner_host", (q: any) => q.eq("owner_user_id", user._id).eq("host_id", host_id))
    .collect()
}

function assignmentByWorkspace(ctx: any, workspace_id: string) {
  return ctx.db
    .query("host_workspace_assignments")
    .withIndex("by_workspace", (q: any) => q.eq("workspace_id", workspace_id))
    .unique()
}

function refuseCloudWorkspace(workspace: { backing?: unknown; access?: unknown }) {
  if (workspace.backing === "cloud-vm" || workspace.access === "cloud") {
    throw new Error("workspace_backing_conflict: cannot assign a host to a cloud workspace")
  }
}

async function createRequestForUser(ctx: any, user: { _id: unknown }, args: { host_id: string }) {
  const now = Date.now()
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const request_id = base64url(crypto.getRandomValues(new Uint8Array(16)))
  await ctx.db.insert("host_enrollment_requests", {
    request_id,
    owner_user_id: user._id,
    host_id: args.host_id,
    nonce,
    expires_at: now + ENROLLMENT_CHALLENGE_TTL_MS,
    created_at: now,
  })
  return { request_id, nonce, expires_at: now + ENROLLMENT_CHALLENGE_TTL_MS }
}

async function enrollForUser(
  ctx: any,
  user: { _id: unknown },
  args: {
    host_id: string
    public_key: string
    request_id: string
    signature: string
    display_name?: string
    ttl_ms?: number
  },
) {
  const now = Date.now()
  const request = await ctx.db
    .query("host_enrollment_requests")
    .withIndex("by_request_id", (q: any) => q.eq("request_id", args.request_id))
    .unique()
  if (
    !request
    || request.owner_user_id !== user._id
    || request.host_id !== args.host_id
    || request.used_at
    || request.expires_at <= now
  ) {
    throw new Error("Invalid host enrollment request")
  }

  // Verified before the nonce is claimed, matching the SQLite authority where
  // that ordering is what stops a bad signature from burning the request.
  //
  // Here it is belt and braces rather than the mechanism: a Convex mutation is
  // transactional, so a throw below rolls the patch back regardless of order.
  // The ordering is kept anyway so the two authorities read the same, and so
  // that a future refactor which splits this across mutations does not silently
  // lose the property. (Verified: reordering these two lines does not fail the
  // policy test, which is the honest reason this note exists.)
  await verifyHostSignature({
    public_key: args.public_key,
    payload: enrollmentPayload({ host_id: args.host_id, request_id: args.request_id, nonce: request.nonce }),
    signature: args.signature,
  })
  // Claiming REWRITES `expires_at` from "the nonce is signable until" to "this
  // evidence is collectable at", starting the consumed-retention window
  // `sweepExpired` reads. It cannot extend validity: `used_at` is now set, and
  // the guard above rejects a claimed request before it looks at the expiry.
  await ctx.db.patch(request._id, { used_at: now, expires_at: now + ENROLLMENT_CONSUMED_RETENTION_MS })

  const expires_at = now + ttl(args.ttl_ms)
  const existing = await enrollmentByOwnerHost(ctx, user, args.host_id)
  if (existing) {
    // Patched, never inserted again: Convex has no unique constraint, so the
    // one-row-per-machine rule lives in this read-then-patch. Re-enrolling
    // clears a previous pause or revoke — the user just proved possession of
    // the key again, which is a stronger statement than either flag.
    await ctx.db.patch(existing._id, {
      public_key: args.public_key,
      ...(args.display_name ? { display_name: args.display_name } : {}),
      last_seen_at: now,
      expires_at,
      updated_at: now,
      paused_at: undefined,
      paused_by: undefined,
      paused_reason: undefined,
      revoked_at: undefined,
    })
    return toEnrollment({ ...existing, ...(args.display_name ? { display_name: args.display_name } : {}), expires_at, last_seen_at: now })
  }

  const enrollment_id = base64url(crypto.getRandomValues(new Uint8Array(16)))
  await ctx.db.insert("host_enrollments", {
    enrollment_id,
    owner_user_id: user._id,
    host_id: args.host_id,
    public_key: args.public_key,
    ...(args.display_name ? { display_name: args.display_name } : {}),
    last_seen_at: now,
    expires_at,
    created_at: now,
    updated_at: now,
  })
  return toEnrollment({
    enrollment_id,
    host_id: args.host_id,
    ...(args.display_name ? { display_name: args.display_name } : {}),
    expires_at,
    last_seen_at: now,
    created_at: now,
  })
}

async function heartbeatForUser(
  ctx: any,
  user: { _id: unknown },
  args: {
    host_id: string
    signature: string
    ttl_ms?: number
    workspace_ids: string[]
    session_authority?: "local" | "managed-private"
  },
) {
  const row = await enrollmentByOwnerHost(ctx, user, args.host_id)
  if (!row || row.revoked_at) throw new Error("Host enrollment not found")
  if (!Array.isArray(args.workspace_ids)) {
    throw new Error("workspace_ids is required — the heartbeat signature covers the served set")
  }
  const workspaceIds = [...new Set(args.workspace_ids.map((id) => {
    const value = typeof id === "string" ? id.trim() : ""
    if (!value) throw new Error("workspace_ids must be non-empty workspace ids")
    return value
  }))].sort()
  if (workspaceIds.length > MAX_ACKED_WORKSPACES) {
    throw new Error("workspace_ids exceeds the served-set cap")
  }
  await verifyHostSignature({
    public_key: row.public_key,
    payload: heartbeatPayloadV2({ host_id: args.host_id, ttl_ms: args.ttl_ms, workspace_ids: workspaceIds }),
    signature: args.signature,
  })
  const now = Date.now()
  const expires_at = now + ttl(args.ttl_ms)
  await ctx.db.patch(row._id, {
    last_seen_at: now,
    expires_at,
    updated_at: now,
    acked_workspace_ids: workspaceIds,
    acked_at: now,
    // The latest beat is the whole truth about the machine's composition: a
    // host that stops declaring is undeclared again, so this assigns rather
    // than coalesces.
    session_authority: args.session_authority,
  })
  // The owner's assignment view rides back on every ack so the machine can
  // reconcile its persisted set — without this, machine consent and owner
  // intent drift apart silently forever.
  const assignments = await assignmentsByOwnerHost(ctx, user, args.host_id)
  return {
    expires_at,
    last_seen_at: now,
    assigned_workspace_ids: assignments.map((assignment: any) => assignment.workspace_id as string).sort(),
  }
}

async function pauseForUser(ctx: any, user: { _id: unknown }, args: { host_id?: string; paused: boolean }) {
  const now = Date.now()
  const patch = args.paused
    ? { paused_at: now, paused_by: "user" as const, paused_reason: "user_paused", updated_at: now }
    : { paused_at: undefined, paused_by: undefined, paused_reason: undefined, updated_at: now }

  // No host id pauses every machine this owner enrolled — the "stop all remote
  // access" the settings switch means. Scoped to the owner's index either way,
  // so it can never reach another user's machines.
  const rows = args.host_id
    ? [await enrollmentByOwnerHost(ctx, user, args.host_id)].filter(Boolean)
    : await ctx.db
        .query("host_enrollments")
        .withIndex("by_owner", (q: any) => q.eq("owner_user_id", user._id))
        .collect()
  for (const row of rows) await ctx.db.patch(row._id, patch)
  return { paused: args.paused, count: rows.length }
}

async function activeForUser(ctx: any, user: { _id: unknown }) {
  const rows = await ctx.db
    .query("host_enrollments")
    .withIndex("by_owner", (q: any) => q.eq("owner_user_id", user._id))
    .collect()
  const row = rows.sort((a: any, b: any) => b.last_seen_at - a.last_seen_at)[0]
  if (!row) return { active: false as const, reason: "not-enrolled" as const }
  // Most-specific first: a revoked enrollment also expires eventually, and
  // reporting the expiry would tell the user to reconnect when the real answer
  // is that access was taken away.
  if (row.revoked_at) return { active: false as const, reason: "revoked" as const }
  if (row.paused_at) return { active: false as const, reason: "paused" as const }
  if (row.expires_at <= Date.now()) return { active: false as const, reason: "expired" as const }
  return { active: true as const, ...toEnrollment(row) }
}

/**
 * The OWNER's declaration that host H serves workspace X. Pure data: no
 * challenge and no TTL — liveness is the enrollment lease, consent is the
 * heartbeat's acked set, and routing requires all three. Cold-registers the
 * workspace doc exactly as the retired per-workspace registration did
 * (`registerLocalForSharingAs`).
 */
async function assignForUser(
  ctx: any,
  user: { _id: unknown; name?: string; email?: string },
  args: {
    workspace_id: string
    host_id: string
    display_name?: string
    org_id?: string
    project_id?: string
    repo_url?: string
    repo_name?: string
    git_branch?: string
    remote_directory?: string
    home_region?: string
  },
) {
  const enrollment = await enrollmentByOwnerHost(ctx, user, args.host_id)
  if (!enrollment || enrollment.revoked_at) throw new Error("Host enrollment not found")
  const existing = await workspaceByPublicId(ctx.db, args.workspace_id)
  if (existing) {
    if (!(await authorizeWorkspaceForUser(ctx, existing, user, "admin"))) throw new Error("Workspace not found")
    refuseCloudWorkspace(existing)
  } else {
    await registerLocalForSharingAs(ctx, {
      workspace_id: args.workspace_id,
      display_name: args.display_name ?? args.workspace_id,
      ...(args.org_id ? { org_id: args.org_id } : {}),
      ...(args.project_id ? { project_id: args.project_id } : {}),
      ...(args.repo_url ? { repo_url: args.repo_url } : {}),
      ...(args.repo_name ? { repo_name: args.repo_name } : {}),
      ...(args.git_branch ? { git_branch: args.git_branch } : {}),
      ...(args.remote_directory ? { remote_directory: args.remote_directory } : {}),
      ...(args.home_region ? { home_region: args.home_region } : {}),
    }, user)
  }
  const now = Date.now()
  // Convex has no unique constraint, so one-host-per-workspace lives in this
  // read-then-patch, the same device `by_owner_host` uses for enrollments.
  const assignment = await assignmentByWorkspace(ctx, args.workspace_id)
  if (assignment) {
    await ctx.db.patch(assignment._id, {
      host_id: args.host_id,
      owner_user_id: user._id,
      updated_at: now,
    })
  } else {
    await ctx.db.insert("host_workspace_assignments", {
      workspace_id: args.workspace_id,
      host_id: args.host_id,
      owner_user_id: user._id,
      assigned_at: now,
      updated_at: now,
    })
  }
  return { assigned: true as const, workspace_id: args.workspace_id, host_id: args.host_id }
}

async function unassignForUser(ctx: any, user: { _id: unknown }, args: { workspace_id: string }) {
  const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
  if (!workspace || !(await authorizeWorkspaceForUser(ctx, workspace, user, "admin"))) {
    throw new Error("Workspace not found")
  }
  const assignment = await assignmentByWorkspace(ctx, args.workspace_id)
  if (!assignment) return { unassigned: false }
  await ctx.db.delete(assignment._id)
  return { unassigned: true }
}

/** Routable host: owner-assigned AND machine-acked AND live lease. */
async function activeWorkspaceHostRow(ctx: any, workspace_id: string) {
  const assignment = await assignmentByWorkspace(ctx, workspace_id)
  if (!assignment) return { active: false as const }
  const enrollment = await ctx.db
    .query("host_enrollments")
    .withIndex("by_owner_host", (q: any) => q.eq("owner_user_id", assignment.owner_user_id).eq("host_id", assignment.host_id))
    .unique()
  if (!hostEnrollmentServesWorkspace(enrollment, assignment.workspace_id, Date.now())) {
    return { active: false as const }
  }
  return {
    active: true as const,
    host_id: assignment.host_id,
    workspace_id: assignment.workspace_id,
    ...(enrollment.display_name ? { display_name: enrollment.display_name } : {}),
    ...(assignment.second_device_open_at ? { second_device_open_at: assignment.second_device_open_at } : {}),
    expires_at: enrollment.expires_at,
    last_seen_at: enrollment.last_seen_at,
    ...(enrollment.session_authority ? { session_authority: enrollment.session_authority } : {}),
  }
}

/** Every live assignment on the account, grouped for the devices surface. */
async function listAssignmentsForUser(ctx: any, user: { _id: unknown }) {
  const assignments = await ctx.db
    .query("host_workspace_assignments")
    .withIndex("by_owner", (q: any) => q.eq("owner_user_id", user._id))
    .collect()
  const now = Date.now()
  const groups = new Map<string, {
    host_id: string
    display_name: string
    last_seen_at: number
    expires_at: number
    workspace_ids: string[]
    acked_workspace_ids: string[]
  }>()
  for (const assignment of assignments.sort((a: any, b: any) =>
    a.host_id === b.host_id
      ? String(a.workspace_id).localeCompare(String(b.workspace_id))
      : String(a.host_id).localeCompare(String(b.host_id)))) {
    let group = groups.get(assignment.host_id)
    if (!group) {
      const enrollment = await enrollmentByOwnerHost(ctx, user, assignment.host_id)
      if (!enrollment || enrollment.revoked_at || enrollment.paused_at || enrollment.expires_at <= now) continue
      group = {
        host_id: assignment.host_id,
        display_name: enrollment.display_name ?? assignment.host_id,
        last_seen_at: enrollment.last_seen_at,
        expires_at: enrollment.expires_at,
        workspace_ids: [],
        acked_workspace_ids: (enrollment.acked_workspace_ids ?? []) as string[],
      }
      groups.set(assignment.host_id, group)
    }
    group.workspace_ids.push(assignment.workspace_id)
  }
  return [...groups.values()]
}

const hostId = { host_id: v.string() }
const enrollArgs = {
  ...hostId,
  public_key: v.string(),
  request_id: v.string(),
  signature: v.string(),
  display_name: v.optional(v.string()),
  ttl_ms: v.optional(v.number()),
}

export const createRequest = authedMutation({
  args: hostId,
  handler: async (ctx, args) => createRequestForUser(ctx, await upsertUser(ctx), args),
})

export const enroll = authedMutation({
  args: enrollArgs,
  handler: async (ctx, args) => enrollForUser(ctx, await upsertUser(ctx), args),
})

export const heartbeat = authedMutation({
  args: {
    ...hostId,
    signature: v.string(),
    ttl_ms: v.optional(v.number()),
    workspace_ids: v.array(v.string()),
    session_authority: v.optional(v.union(v.literal("local"), v.literal("managed-private"))),
  },
  handler: async (ctx, args) => heartbeatForUser(ctx, await upsertUser(ctx), args),
})

export const pause = authedMutation({
  args: { host_id: v.optional(v.string()), paused: v.boolean() },
  handler: async (ctx, args) => pauseForUser(ctx, await upsertUser(ctx), args),
})

export const active = authedQuery({
  args: {},
  handler: async (ctx) => {
    // A QUERY, so it looks the user up rather than upserting — `upsertUser`
    // writes, and a query context has no `patch`. A caller who has never signed
    // in simply has nothing enrolled; that is an answer, not an error.
    const user = await userByTokenIdentifier(ctx.db, ctx.identity.tokenIdentifier)
    if (!user) return { active: false as const, reason: "not-enrolled" as const }
    return activeForUser(ctx, user)
  },
})

// Service variants: Hosted Server calls these on behalf of a user it has
// already authenticated.
export const createRequestForService = serviceMutation({
  args: { user: serviceUser, ...hostId },
  handler: async (ctx, args) => createRequestForUser(ctx, await upsertServiceUser(ctx, args.user), args),
})

export const enrollForService = serviceMutation({
  args: { user: serviceUser, ...enrollArgs },
  handler: async (ctx, args) => enrollForUser(ctx, await upsertServiceUser(ctx, args.user), args),
})

export const heartbeatForService = serviceMutation({
  args: {
    user: serviceUser,
    ...hostId,
    signature: v.string(),
    ttl_ms: v.optional(v.number()),
    workspace_ids: v.array(v.string()),
    session_authority: v.optional(v.union(v.literal("local"), v.literal("managed-private"))),
  },
  handler: async (ctx, args) => heartbeatForUser(ctx, await upsertServiceUser(ctx, args.user), args),
})

const assignArgs = {
  workspace_id: v.string(),
  ...hostId,
  display_name: v.optional(v.string()),
  org_id: v.optional(v.string()),
  project_id: v.optional(v.string()),
  repo_url: v.optional(v.string()),
  repo_name: v.optional(v.string()),
  git_branch: v.optional(v.string()),
  remote_directory: v.optional(v.string()),
  home_region: v.optional(v.string()),
}

export const assignWorkspace = authedMutation({
  args: assignArgs,
  handler: async (ctx, args) => assignForUser(ctx, await upsertUser(ctx), args),
})

export const assignWorkspaceForService = serviceMutation({
  args: { user: serviceUser, ...assignArgs },
  handler: async (ctx, args) => assignForUser(ctx, await upsertServiceUser(ctx, args.user), args),
})

export const unassignWorkspace = authedMutation({
  args: { workspace_id: v.string() },
  handler: async (ctx, args) => unassignForUser(ctx, await upsertUser(ctx), args),
})

export const unassignWorkspaceForService = serviceMutation({
  args: { user: serviceUser, workspace_id: v.string() },
  handler: async (ctx, args) => unassignForUser(ctx, await upsertServiceUser(ctx, args.user), args),
})

export const activeWorkspaceHost = authedQuery({
  args: { workspace_id: v.string() },
  handler: async (ctx, args) => {
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace || !(await authorizeWorkspace(ctx, workspace, "read"))) return { active: false as const }
    return activeWorkspaceHostRow(ctx, args.workspace_id)
  },
})

export const listAssignments = authedQuery({
  args: {},
  handler: async (ctx) => {
    // A QUERY, so it looks the user up rather than upserting (`active` above
    // documents why). Nothing enrolled means nothing assigned.
    const user = await userByTokenIdentifier(ctx.db, ctx.identity.tokenIdentifier)
    if (!user) return []
    return listAssignmentsForUser(ctx, user)
  },
})

export const markSecondDeviceOpen = authedMutation({
  args: { workspace_id: v.string() },
  handler: async (ctx, args) => {
    const user = await upsertUser(ctx)
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace || !(await authorizeWorkspaceForUser(ctx, workspace, user, "read"))) {
      throw new Error("Workspace not found")
    }
    const assignment = await assignmentByWorkspace(ctx, args.workspace_id)
    const now = Date.now()
    const owned = assignment && assignment.owner_user_id === user._id
    if (owned && !assignment.second_device_open_at) {
      await ctx.db.patch(assignment._id, { second_device_open_at: now, updated_at: now })
    }
    return { recorded: !!owned, second_device_open_at: now }
  },
})

export const pauseForService = serviceMutation({
  args: { user: serviceUser, host_id: v.optional(v.string()), paused: v.boolean() },
  handler: async (ctx, args) => pauseForUser(ctx, await upsertServiceUser(ctx, args.user), args),
})

/**
 * Retire collectable enrollment requests.
 *
 * Without this the table grew monotonically: `createRequestForUser` inserts a
 * server-random-keyed row on every `POST /requests` and nothing ever deleted
 * one. It is deliberately excluded from the org-deletion cascade
 * (`orgs.ORG_RETAINED_TABLES`, "user-owned and short-lived") — that note
 * describes the `expires_at` predicate, and until this sweep existed nothing
 * acted on it.
 *
 * Same shape and reasoning as `idempotency.sweepExpired` and
 * `connectionAttempts.sweepExpired`: level-triggered, so a saturated tick
 * leaves the rest for the next one and nothing is skipped forever; ranged on
 * `by_expires_at` so the read set is bounded by collectable rows rather than by
 * table size (W5's no-unbounded-read invariant).
 *
 * One clock covers both kinds of row because `expires_at` MEANS "collectable
 * at": an unconsumed nonce reaches it at creation + ENROLLMENT_CHALLENGE_TTL_MS,
 * and `enrollForUser` pushes a consumed one out to
 * `used_at + ENROLLMENT_CONSUMED_RETENTION_MS`. So a consumed row is never
 * collected inside its retention window, which is the property a future
 * exact-retry answer depends on.
 *
 * Correctness never depends on a tick having run — a stale row is inert, since
 * `enrollForUser` rejects on `used_at` and on `expires_at <= now`. This only
 * reclaims storage, which is why the cadence is loose.
 */
export const sweepExpired = cronMutation({
  // `now` optional so the cron can call with no clock argument; tests pass one
  // to drive expiry deterministically. Same convention as the two sweeps above.
  args: { now: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now()
    const limit = Math.min(args.limit ?? ENROLLMENT_REQUEST_SWEEP_LIMIT, ENROLLMENT_REQUEST_SWEEP_LIMIT)
    const stale = await ctx.db
      .query("host_enrollment_requests")
      .withIndex("by_expires_at", (q: any) => q.lte("expires_at", now))
      .take(limit)
    for (const doc of stale) await ctx.db.delete(doc._id)
    return { swept: stale.length }
  },
})

/**
 * Service-authenticated routing lookup for the internal relay resolver.
 *
 * The hosted relay resolver calls in with the control-plane service token and
 * no end-user identity, so it cannot use `activeWorkspaceHost` above (which
 * requires a signed workspace read). It answers the same question and applies
 * the same three conditions — owner-assigned AND inside the machine's
 * heartbeat-acked served set AND a live enrollment lease — and rechecks the
 * authoritative workspace posture in the same call, matching
 * `authority/adapters/d1/user-hosted-relay-target.ts` semantics.
 */
export const activeWorkspaceHostForRelay = serviceQuery({
  args: { workspace_id: v.string() },
  handler: async (ctx, args) => {
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (
      !workspace
      || workspace.deleted_at
      || workspace.access !== "user-hosted"
      || workspace.backing !== "local-worktree"
    ) {
      return { active: false as const }
    }
    const org = workspace.org_id ? await ctx.db.get(workspace.org_id) : undefined
    if (!org || (org as { deleted_at?: number }).deleted_at) return { active: false as const }
    const row = await activeWorkspaceHostRow(ctx, args.workspace_id)
    if (!row.active) return { active: false as const }
    return { active: true as const, host_id: row.host_id, backing: workspace.backing }
  },
})

export const activeForService = serviceQuery({
  args: { user: serviceUser },
  handler: async (ctx, args) => {
    // A QUERY, so it cannot upsert the user the way the mutations above do —
    // it looks the user up instead. A caller asking about a user who has never
    // signed in is not an error worth throwing for; there is simply nothing
    // enrolled.
    const user = await userByTokenIdentifier(ctx.db, args.user.token_identifier)
    if (!user) return { active: false as const, reason: "not-enrolled" as const }
    return activeForUser(ctx, user)
  },
})

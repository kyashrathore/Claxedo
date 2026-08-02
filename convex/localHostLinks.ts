import { v } from "convex/values"
import {
  authedMutation,
  authedQuery,
  authorizeWorkspace,
  authorizeWorkspaceForUser,
  serviceMutation,
  serviceQuery,
  upsertServiceUser,
  upsertUser,
  workspaceByPublicId,
} from "./model"

const workspaceId = { workspace_id: v.string() }
const serviceUser = v.object({
  token_identifier: v.string(),
  subject: v.optional(v.string()),
  issuer: v.optional(v.string()),
  email: v.optional(v.string()),
  name: v.optional(v.string()),
  image_url: v.optional(v.string()),
})

const DEFAULT_TTL_MS = 60_000
const MAX_TTL_MS = 5 * 60_000
const CHALLENGE_TTL_MS = 60_000

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

function registrationPayload(input: {
  workspace_id: string
  host_id: string
  challenge_id: string
  nonce: string
}) {
  return [
    "claxedo.local-host-link.register.v1",
    `workspace_id=${input.workspace_id}`,
    `host_id=${input.host_id}`,
    `challenge_id=${input.challenge_id}`,
    `nonce=${input.nonce}`,
  ].join("\n")
}

function heartbeatPayload(input: {
  workspace_id: string
  host_id: string
  ttl_ms?: number
}) {
  return [
    "claxedo.local-host-link.heartbeat.v1",
    `workspace_id=${input.workspace_id}`,
    `host_id=${input.host_id}`,
    `ttl_ms=${input.ttl_ms ?? ""}`,
  ].join("\n")
}

async function verifyHostSignature(input: {
  public_key: string
  payload: string
  signature: string
}) {
  const jwk = JSON.parse(input.public_key)
  if (jwk?.kty !== "EC" || jwk?.crv !== "P-256") throw new Error("Invalid host public key")
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  )
  if (!await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    base64urlBytes(input.signature),
    new TextEncoder().encode(input.payload),
  )) {
    throw new Error("Invalid host attestation")
  }
}

function refuseCloudWorkspace(workspace: { backing?: unknown; access?: unknown }) {
  // Local host links belong to user-hosted local workspaces; a cloud workspace
  // must never grow one (and must never be flipped by this flow).
  if (workspace.backing === "cloud-vm" || workspace.access === "cloud") {
    throw new Error("workspace_backing_conflict: cannot attach a local host link to a cloud workspace")
  }
}

async function createChallengeForUser(ctx: any, user: { _id: unknown }, args: {
  workspace_id: string
  host_id: string
}) {
  const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
  // A never-registered workspaceId may take a challenge: issuing one mutates
  // nothing about workspaces, and ownership is established at register
  // (after host proof) where the doc is created. When the doc EXISTS, every
  // ownership/backing check still applies.
  if (workspace) {
    if (!await authorizeWorkspaceForUser(ctx, workspace, user, "admin")) throw new Error("Workspace not found")
    refuseCloudWorkspace(workspace)
  }
  const now = Date.now()
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge_id = base64url(crypto.getRandomValues(new Uint8Array(16)))
  await ctx.db.insert("host_attestation_challenges", {
    challenge_id,
    // Keyed by the PUBLIC workspace id + user so the challenge works whether
    // or not the workspace doc exists yet.
    workspace_id: args.workspace_id,
    owner_user_id: user._id,
    host_id: args.host_id,
    nonce,
    expires_at: now + CHALLENGE_TTL_MS,
    created_at: now,
  })
  return {
    challenge_id,
    nonce,
    expires_at: now + CHALLENGE_TTL_MS,
  }
}

async function registerForUser(ctx: any, user: { _id: unknown }, args: {
  workspace_id: string
  host_id: string
  public_key: string
  challenge_id: string
  signature: string
  display_name?: string
  ttl_ms?: number
}) {
  const existing_workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
  if (existing_workspace) {
    if (!await authorizeWorkspaceForUser(ctx, existing_workspace, user, "admin")) throw new Error("Workspace not found")
    refuseCloudWorkspace(existing_workspace)
  }
  const now = Date.now()
  const challenge = await ctx.db
    .query("host_attestation_challenges")
    .withIndex("by_challenge_id", (q: any) => q.eq("challenge_id", args.challenge_id))
    .unique()
  if (
    !challenge
    || challenge.workspace_id !== args.workspace_id
    || challenge.owner_user_id !== user._id
    || challenge.host_id !== args.host_id
    || challenge.used_at
    || challenge.expires_at <= now
  ) {
    throw new Error("Invalid host attestation challenge")
  }
  await verifyHostSignature({
    public_key: args.public_key,
    payload: registrationPayload({
      workspace_id: args.workspace_id,
      host_id: args.host_id,
      challenge_id: args.challenge_id,
      nonce: challenge.nonce,
    }),
    signature: args.signature,
  })
  await ctx.db.patch(challenge._id, { used_at: now })
  // Host proof passed. A never-registered workspace is created HERE — never
  // before signature verification — owned by the proving caller, with
  // user-hosted local backing (mirrors workspaces.registerLocalForSharing's
  // insert for a new workspace; the route's subsequent registerLocalForSharing
  // call then just patches metadata onto this doc).
  const workspace = existing_workspace ?? await (async () => {
    const doc = {
      workspace_id: args.workspace_id,
      owner_user_id: user._id,
      backing: "local-worktree" as const,
      access: "user-hosted" as const,
      display_name: args.display_name ?? args.workspace_id,
      created_at: now,
      updated_at: now,
    }
    const id = await ctx.db.insert("workspaces", doc)
    await ctx.db.insert("workspace_memberships", {
      workspace_id: id,
      user_id: user._id,
      role: "owner",
      created_at: now,
      updated_at: now,
    })
    return { _id: id, ...doc, home_region: undefined as string | undefined }
  })()
  const expires_at = now + ttl(args.ttl_ms)
  const existing = (await ctx.db
    .query("local_host_links")
    .withIndex("by_workspace", (q: any) => q.eq("workspace_id", workspace._id))
    .collect())
    .find((item: any) => item.host_id === args.host_id)

  if (existing) {
    await ctx.db.patch(existing._id, {
      public_key: args.public_key,
      display_name: args.display_name,
      last_seen_at: now,
      expires_at,
      paused_at: undefined,
      paused_by: undefined,
      paused_reason: undefined,
      revoked_at: undefined,
      updated_at: now,
    })
    return {
      host_id: args.host_id,
      workspace_id: args.workspace_id,
      home_region: workspace.home_region,
      expires_at,
      paused: false,
    }
  }

  await ctx.db.insert("local_host_links", {
    workspace_id: workspace._id,
    owner_user_id: user._id,
    host_id: args.host_id,
    public_key: args.public_key,
    display_name: args.display_name,
    last_seen_at: now,
    expires_at,
    created_at: now,
    updated_at: now,
  })
  return {
    host_id: args.host_id,
    workspace_id: args.workspace_id,
    home_region: workspace.home_region,
    expires_at,
    paused: false,
  }
}

async function heartbeatForUser(ctx: any, user: { _id: unknown }, args: {
  workspace_id: string
  host_id: string
  signature: string
  ttl_ms?: number
}) {
  const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
  if (!workspace || !await authorizeWorkspaceForUser(ctx, workspace, user, "admin")) throw new Error("Workspace not found")
  // Look up by (workspace, host_id) — NOT `by_host_id`.unique(), which throws
  // when the same host_id was ever registered for another workspace (a real
  // case when a CLI re-runs `claxedo up` across workspaces). Among any links
  // for this host in this workspace, prefer the live (non-revoked) one.
  const links = (await ctx.db
    .query("local_host_links")
    .withIndex("by_workspace", (q: any) => q.eq("workspace_id", workspace._id))
    .collect())
    .filter((item: any) => item.host_id === args.host_id)
  const link = links.find((item: any) => !item.revoked_at) ?? links[0]
  if (!link || link.revoked_at) throw new Error("Local Host Link not found")
  if (!link.public_key) throw new Error("Host attestation required")
  await verifyHostSignature({
    public_key: link.public_key,
    payload: heartbeatPayload({
      workspace_id: args.workspace_id,
      host_id: args.host_id,
      ttl_ms: args.ttl_ms,
    }),
    signature: args.signature,
  })
  const now = Date.now()
  const expires_at = now + ttl(args.ttl_ms)
  await ctx.db.patch(link._id, {
    last_seen_at: now,
    expires_at,
    updated_at: now,
  })
  return {
    host_id: args.host_id,
    workspace_id: args.workspace_id,
    home_region: workspace.home_region,
    expires_at,
    paused: !!link.paused_at,
  }
}

async function pauseForUser(ctx: any, user: { _id: unknown }, args: {
  workspace_id: string
  host_id?: string
  paused: boolean
}) {
  const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
  if (!workspace || !await authorizeWorkspaceForUser(ctx, workspace, user, "admin")) throw new Error("Workspace not found")
  const links = await ctx.db
    .query("local_host_links")
    .withIndex("by_workspace", (q: any) => q.eq("workspace_id", workspace._id))
    .collect()
  const targets = links.filter((item: any) => !args.host_id || item.host_id === args.host_id)
  const now = Date.now()
  for (const link of targets) {
    await ctx.db.patch(link._id, {
      paused_at: args.paused ? now : undefined,
      paused_by: args.paused ? "user" : undefined,
      paused_reason: args.paused ? "user_paused" : undefined,
      updated_at: now,
    })
  }
  return {
    workspace_id: args.workspace_id,
    paused: args.paused,
    count: targets.length,
  }
}

async function markSecondDeviceOpenForUser(ctx: any, user: { _id: unknown }, args: { workspace_id: string }) {
  const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
  if (!workspace || !await authorizeWorkspaceForUser(ctx, workspace, user, "read")) throw new Error("Workspace not found")
  const links = (await ctx.db
    .query("local_host_links")
    .withIndex("by_workspace", (q: any) => q.eq("workspace_id", workspace._id))
    .collect())
    .filter((link: any) => link.owner_user_id === user._id && !link.revoked_at)
  const now = Date.now()
  for (const link of links) {
    if (!link.second_device_open_at) await ctx.db.patch(link._id, { second_device_open_at: now, updated_at: now })
  }
  return { recorded: links.length > 0, second_device_open_at: now }
}

export const createChallenge = authedMutation({
  args: {
    ...workspaceId,
    host_id: v.string(),
  },
  handler: async (ctx, args) => {
    return createChallengeForUser(ctx, await upsertUser(ctx), args)
  },
})

export const register = authedMutation({
  args: {
    ...workspaceId,
    host_id: v.string(),
    public_key: v.string(),
    challenge_id: v.string(),
    signature: v.string(),
    display_name: v.optional(v.string()),
    ttl_ms: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return registerForUser(ctx, await upsertUser(ctx), args)
  },
})

export const createChallengeForService = serviceMutation({
  args: {
    user: serviceUser,
    ...workspaceId,
    host_id: v.string(),
  },
  handler: async (ctx, args) => {
    return createChallengeForUser(ctx, await upsertServiceUser(ctx, args.user), args)
  },
})

export const registerForService = serviceMutation({
  args: {
    user: serviceUser,
    ...workspaceId,
    host_id: v.string(),
    public_key: v.string(),
    challenge_id: v.string(),
    signature: v.string(),
    display_name: v.optional(v.string()),
    ttl_ms: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return registerForUser(ctx, await upsertServiceUser(ctx, args.user), args)
  },
})

export const heartbeat = authedMutation({
  args: {
    ...workspaceId,
    host_id: v.string(),
    signature: v.string(),
    ttl_ms: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return heartbeatForUser(ctx, await upsertUser(ctx), args)
  },
})

export const heartbeatForService = serviceMutation({
  args: {
    user: serviceUser,
    ...workspaceId,
    host_id: v.string(),
    signature: v.string(),
    ttl_ms: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return heartbeatForUser(ctx, await upsertServiceUser(ctx, args.user), args)
  },
})

export const pause = authedMutation({
  args: {
    ...workspaceId,
    host_id: v.optional(v.string()),
    paused: v.boolean(),
  },
  handler: async (ctx, args) => {
    return pauseForUser(ctx, await upsertUser(ctx), args)
  },
})

export const pauseForService = serviceMutation({
  args: {
    user: serviceUser,
    ...workspaceId,
    host_id: v.optional(v.string()),
    paused: v.boolean(),
  },
  handler: async (ctx, args) => {
    return pauseForUser(ctx, await upsertServiceUser(ctx, args.user), args)
  },
})

export const markSecondDeviceOpen = authedMutation({
  args: workspaceId,
  handler: async (ctx, args) => markSecondDeviceOpenForUser(ctx, await upsertUser(ctx), args),
})

export const active = authedQuery({
  args: workspaceId,
  handler: async (ctx, args) => {
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace || !await authorizeWorkspace(ctx, workspace, "read")) return { active: false }
    const now = Date.now()
    const links = await ctx.db
      .query("local_host_links")
      .withIndex("by_workspace", (q) => q.eq("workspace_id", workspace._id))
      .collect()
    const link = links
      .filter((item) => !item.revoked_at && !item.paused_at && item.expires_at > now)
      .sort((a, b) => b.last_seen_at - a.last_seen_at)[0]
    if (!link) return { active: false }
    return {
      active: true,
      host_id: link.host_id,
      workspace_id: args.workspace_id,
      display_name: link.display_name,
      second_device_open_at: link.second_device_open_at,
      expires_at: link.expires_at,
      last_seen_at: link.last_seen_at,
    }
  },
})

// Service-authenticated active-link resolver for the relay target lookup.
// The hosted internal relay resolver calls in with the control-plane service
// token (no end-user identity), so it cannot use `active` (which requires a
// signed workspace-read authorization). Returns the current user-hosted host
// for a workspace so the relay can route a browser/client connection to the
// host tunnel that dialed out.
export const activeForRelay = serviceQuery({
  args: workspaceId,
  handler: async (ctx, args) => {
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace) return { active: false }
    const now = Date.now()
    const links = await ctx.db
      .query("local_host_links")
      .withIndex("by_workspace", (q) => q.eq("workspace_id", workspace._id))
      .collect()
    const link = links
      .filter((item) => !item.revoked_at && !item.paused_at && item.expires_at > now)
      .sort((a, b) => b.last_seen_at - a.last_seen_at)[0]
    if (!link) return { active: false }
    return {
      active: true,
      host_id: link.host_id,
      workspace_id: args.workspace_id,
      backing: workspace.backing ?? "local-worktree",
      expires_at: link.expires_at,
      last_seen_at: link.last_seen_at,
    }
  },
})

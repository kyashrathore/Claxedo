/**
 * Network policy — manages deny-by-default egress policy for sandboxes.
 *
 * The DEFAULT_ALLOWLIST is always applied as the baseline (package registries,
 * git, AI APIs, etc). Users add custom host/domain entries on top.
 */

import { randomUUID } from "crypto"
import { eq } from "drizzle-orm"
import { ClaxedoDB } from "../../platform/db/db"
import { ClaxedoNetworkPolicyTable } from "./policy.sql"
import { CONTROL_PLANE_HOSTS, DEFAULT_ALLOWLIST, PROVIDER_TO_GROUP, flattenDefaultAllowlist, type NetworkPolicyEntry, type PolicyConstraints, type PolicyKind, type PolicyWrite } from "./types"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"

const log = Log.create({ service: "network-policy" })

function now() {
  return Date.now()
}

function parseConstraints(json: string | null): PolicyConstraints {
  if (!json) return {}
  try {
    return JSON.parse(json)
  } catch {
    return {}
  }
}

function toEntry(row: typeof ClaxedoNetworkPolicyTable.$inferSelect): NetworkPolicyEntry {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    harness: row.harness,
    target: row.target,
    kind: row.kind as PolicyKind,
    constraints: parseConstraints(row.constraints_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

const VALID_KINDS: PolicyKind[] = ["host", "domain", "group"]

function validateTarget(target: string, kind: PolicyKind): string | null {
  if (!target?.trim()) return "Target is required"
  if (!VALID_KINDS.includes(kind)) return `Invalid kind: ${kind}`
  if (kind === "host") {
    if (!/^[a-zA-Z0-9._:-]+$/.test(target)) return `Invalid host: ${target}`
  }
  if (kind === "domain") {
    if (!target.startsWith("*.")) return `Domain must start with *. (got: ${target})`
    if (!/^\*\.[a-zA-Z0-9.-]+$/.test(target)) return `Invalid domain pattern: ${target}`
  }
  if (kind === "group") {
    if (!DEFAULT_ALLOWLIST[target]) return `Unknown group: ${target}`
  }
  return null
}

/** Create a new network policy entry. */
export function createPolicy(input: PolicyWrite): NetworkPolicyEntry | { error: string } {
  const err = validateTarget(input.target, input.kind)
  if (err) return { error: err }

  const ts = now()
  const row = {
    id: randomUUID(),
    workspace_id: input.workspace_id ?? null,
    harness: input.harness ?? null,
    target: input.target,
    kind: input.kind,
    constraints_json: input.constraints ? JSON.stringify(input.constraints) : "{}",
    created_at: ts,
    updated_at: ts,
  }

  ClaxedoDB.use((db) => db.insert(ClaxedoNetworkPolicyTable).values(row).run())
  log.info("Created network policy", { id: row.id, target: row.target, kind: row.kind })
  return toEntry(row)
}

/** Get a single policy entry. */
export function getPolicy(id: string): NetworkPolicyEntry | undefined {
  const row = ClaxedoDB.use((db) =>
    db.select().from(ClaxedoNetworkPolicyTable).where(eq(ClaxedoNetworkPolicyTable.id, id)).get(),
  )
  return row ? toEntry(row) : undefined
}

/** Update a policy entry. */
export function updatePolicy(id: string, input: Partial<PolicyWrite>): NetworkPolicyEntry | { error: string } | undefined {
  const existing = ClaxedoDB.use((db) =>
    db.select().from(ClaxedoNetworkPolicyTable).where(eq(ClaxedoNetworkPolicyTable.id, id)).get(),
  )
  if (!existing) return undefined

  const target = input.target ?? existing.target
  const kind = (input.kind ?? existing.kind) as PolicyKind
  const err = validateTarget(target, kind)
  if (err) return { error: err }

  const ts = now()
  ClaxedoDB.use((db) =>
    db
      .update(ClaxedoNetworkPolicyTable)
      .set({
        target,
        kind,
        workspace_id: input.workspace_id ?? existing.workspace_id,
        harness: input.harness ?? existing.harness,
        constraints_json: input.constraints ? JSON.stringify(input.constraints) : existing.constraints_json,
        updated_at: ts,
      })
      .where(eq(ClaxedoNetworkPolicyTable.id, id))
      .run(),
  )

  return getPolicy(id)
}

/** Delete a policy entry. */
export function deletePolicy(id: string): boolean {
  const result = ClaxedoDB.use((db) =>
    db.delete(ClaxedoNetworkPolicyTable).where(eq(ClaxedoNetworkPolicyTable.id, id)).run(),
  )
  return result.changes > 0
}

/** List policy entries, optionally filtered by workspace. */
export function listPolicies(workspaceId?: string | null): NetworkPolicyEntry[] {
  const rows = ClaxedoDB.use((db) =>
    db.select().from(ClaxedoNetworkPolicyTable).all(),
  )
  const entries = rows.map(toEntry)
  if (workspaceId) {
    return entries.filter((e) => !e.workspace_id || e.workspace_id === workspaceId)
  }
  return entries
}

/**
 * Resolve the effective allowlist for a workspace.
 * Combines DEFAULT_ALLOWLIST + CONTROL_PLANE_HOSTS + user-defined entries.
 */
export function resolveEffectivePolicy(workspaceId: string): string[] {
  const entries = listPolicies(workspaceId)
  const allowed = new Set<string>()

  // Always include baseline
  for (const host of flattenDefaultAllowlist()) allowed.add(host)
  for (const host of CONTROL_PLANE_HOSTS) allowed.add(host)

  // Add user-defined entries
  for (const entry of entries) {
    if (entry.constraints.enabled === false) continue
    if (entry.workspace_id && entry.workspace_id !== workspaceId) continue
    if (entry.kind === "group") {
      const hosts = DEFAULT_ALLOWLIST[entry.target]
      if (hosts) hosts.forEach((h) => allowed.add(h))
    } else {
      allowed.add(entry.target)
    }
  }

  return [...allowed]
}

/**
 * Check if a target host is allowed by the effective policy.
 */
export function isTargetAllowed(workspaceId: string, targetHost: string): boolean {
  const allowed = resolveEffectivePolicy(workspaceId)

  if (allowed.includes(targetHost)) return true

  // Wildcard domain match (*.example.com matches sub.example.com)
  for (const entry of allowed) {
    if (entry.startsWith("*.") && targetHost.endsWith(entry.slice(1))) return true
  }

  return false
}

// ── Auto-sync: URL → network policy ──────────────────────────────────────

/**
 * Ensure a host network policy exists for a URL's hostname.
 * Called automatically when a remote MCP server or similar outbound
 * endpoint is configured.
 */
export function ensureHostForUrl(url: string, source: string): void {
  try {
    const hostname = new URL(url).hostname
    if (!hostname) return

    // Check if already in the default allowlist or control-plane
    if (CONTROL_PLANE_HOSTS.includes(hostname)) return
    const flat = flattenDefaultAllowlist()
    if (flat.includes(hostname)) return
    for (const entry of flat) {
      if (entry.startsWith("*.") && hostname.endsWith(entry.slice(1))) return
    }

    // Check existing user entries
    const existing = ClaxedoDB.use((db) =>
      db.select().from(ClaxedoNetworkPolicyTable).all()
        .find((row) => row.target === hostname && row.kind === "host"),
    )
    if (existing) return

    const ts = now()
    ClaxedoDB.use((db) =>
      db.insert(ClaxedoNetworkPolicyTable).values({
        id: randomUUID(),
        workspace_id: null,
        harness: null,
        target: hostname,
        kind: "host",
        constraints_json: JSON.stringify({ auto: true, source }),
        created_at: ts,
        updated_at: ts,
      }).run(),
    )
    log.info("Auto-added network policy for URL", { hostname, source })
  } catch {}
}

/**
 * Ensure a host policy for a git repo URL (HTTPS or SSH).
 */
export function ensureHostForRepo(repoUrl: string): void {
  // SSH format: git@github.com:user/repo.git
  const sshMatch = repoUrl.match(/^git@([^:]+):/)
  if (sshMatch) {
    ensureHostForUrl(`https://${sshMatch[1]}`, `repo:${repoUrl}`)
    return
  }
  ensureHostForUrl(repoUrl, `repo:${repoUrl}`)
}

/**
 * Sync network policies for all remote MCP servers.
 * Auto-adds host entries for remote MCP URLs.
 */
export function syncMcpHosts(mcp: Record<string, { type?: string; url?: string }>): void {
  for (const [name, server] of Object.entries(mcp)) {
    if (server.type === "remote" && server.url) {
      ensureHostForUrl(server.url, `mcp:${name}`)
    }
  }
}

// ── Auto-sync: credentials → group policies ─────────────────────────────

function upsertAutoPolicy(target: string, kind: PolicyKind, source: string): void {
  const existing = ClaxedoDB.use((db) =>
    db.select().from(ClaxedoNetworkPolicyTable).all()
      .find((row) => row.target === target && row.kind === kind),
  )
  if (existing) return

  const ts = now()
  ClaxedoDB.use((db) =>
    db.insert(ClaxedoNetworkPolicyTable).values({
      id: randomUUID(),
      workspace_id: null,
      harness: null,
      target,
      kind,
      constraints_json: JSON.stringify({ auto: true, source }),
      created_at: ts,
      updated_at: ts,
    }).run(),
  )
  log.info("Auto-added network policy", { target, kind, source })
}

function removeAutoEntries(target: string, kind: PolicyKind, source: string): void {
  const rows = ClaxedoDB.use((db) =>
    db.select().from(ClaxedoNetworkPolicyTable).all()
      .filter((row) => row.target === target && row.kind === kind),
  )
  for (const row of rows) {
    const c = parseConstraints(row.constraints_json) as Record<string, unknown>
    if (!c.auto) continue
    if (source && c.source !== source) continue
    ClaxedoDB.use((db) =>
      db.delete(ClaxedoNetworkPolicyTable).where(eq(ClaxedoNetworkPolicyTable.id, row.id)).run(),
    )
    log.info("Removed auto-created network policy", { target, kind, source, policyId: row.id })
  }
}

/** Auto-add a group policy when credentials are stored for a provider. */
export function ensurePresetForProvider(providerId: string): void {
  const group = PROVIDER_TO_GROUP[providerId]
  if (!group || !DEFAULT_ALLOWLIST[group]) return
  upsertAutoPolicy(group, "group", `credential:${providerId}`)
}

/** Remove auto-created group policy when credentials are deleted. */
export function removeAutoPresetForProvider(providerId: string): void {
  const group = PROVIDER_TO_GROUP[providerId]
  if (!group) return
  removeAutoEntries(group, "group", `credential:${providerId}`)
}

/**
 * Remove auto-created host entries for a source.
 */
export function removeAutoHostsForSource(source: string): void {
  const rows = ClaxedoDB.use((db) =>
    db.select().from(ClaxedoNetworkPolicyTable).all()
      .filter((row) => {
        const c = parseConstraints(row.constraints_json) as Record<string, unknown>
        return c.auto && c.source === source
      }),
  )

  for (const row of rows) {
    ClaxedoDB.use((db) =>
      db.delete(ClaxedoNetworkPolicyTable).where(eq(ClaxedoNetworkPolicyTable.id, row.id)).run(),
    )
    log.info("Removed auto-created network policy", { target: row.target, source })
  }
}

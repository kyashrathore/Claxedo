import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { ulid } from "ulid"
import type { WorkItem } from "../model/types"
import { cancelNodeExecution, reconcileExecution, startExecution, startOrchestration } from "../orchestrator/executor"
import type { ProviderName, ProviderPreview, ProviderQueryMode } from "../orchestrator/events/connector"
import { getWorkGraph } from "../orchestrator/workgraph-bridge"
import { createRunInDb } from "../db/run"
import type { IEventStore } from "../orchestrator/core/services/event-store"
import { dir } from "../dir"
import type { ExecutionAdapter } from "../execution"
import { adapter, preview, validate, type ProviderAuthResolver, type ProviderConnection, type ProviderFactory } from "../providers"
import { backfillRepos, buckets, inferRepo, resolveRepoDir, type RepoBindingResolver } from "../repo"

function sliceRunId(row: any) {
  if (row.status === "planning") return row.plan_run_id ?? null
  if (row.status === "planned") return row.last_run_id ?? row.plan_run_id ?? null
  if (row.status === "executing" || row.status === "completed" || row.status === "failed") {
    return row.last_run_id ?? row.plan_run_id ?? null
  }
  return row.plan_run_id ?? row.last_run_id ?? null
}

function sliceRow(db: any, row: any) {
  const runId = sliceRunId(row)
  const exec = runId
    ? (db.query("SELECT runtime_type, session_id, pty_id, directory FROM run_exec_current WHERE run_id = ?").get(runId) as any)
    : null
  return {
    slice_id: row.source_id,
    goal: row.goal,
    kind: row.kind,
    title: row.title,
    content: row.content,
    source_path: row.source_path ?? null,
    status: row.status,
    plan_run_id: row.plan_run_id ?? null,
    last_run_id: row.last_run_id ?? null,
    trace_run_id: runId,
    runtime_type: exec?.runtime_type ?? null,
    session_id: exec?.session_id ?? null,
    pty_id: exec?.pty_id ?? null,
    directory: exec?.directory ?? null,
    worktree_path: exec?.directory ?? null,
    provider: row.provider ?? null,
    repo_ref: row.repo_ref ?? null,
    repo_label: row.repo_label ?? null,
    provider_connection_id: row.provider_connection_id ?? null,
    import_mode: row.import_mode ?? null,
    import_query: json(row.import_query),
    mission_item_id: row.mission_item_id ?? null,
    error: row.error ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function slicePick(db: any, sliceId: string) {
  const row = db.query("SELECT * FROM sources_current WHERE source_id = ?").get(sliceId) as any
  return row ? sliceRow(db, row) : null
}

function slicePatch(db: any, sliceId: string, changes: Record<string, string | null>) {
  const keys = Object.keys(changes)
  if (!keys.length) return
  db.run(
    `UPDATE sources_current SET ${keys.map((key) => `${key} = ?`).join(", ")}, updated_at = ? WHERE source_id = ?`,
    [...keys.map((key) => changes[key]), new Date().toISOString(), sliceId],
  )
}

function listSlices(db: any, repoRef?: string | null) {
  if (repoRef === "__unbound__") {
    return (db.query("SELECT * FROM sources_current WHERE repo_ref IS NULL ORDER BY updated_at DESC").all() as any[]).map((row) => sliceRow(db, row))
  }
  if (repoRef) {
    return (db.query("SELECT * FROM sources_current WHERE repo_ref = ? ORDER BY updated_at DESC").all(repoRef) as any[]).map((row) => sliceRow(db, row))
  }
  return (db.query("SELECT * FROM sources_current ORDER BY updated_at DESC").all() as any[]).map((row) => sliceRow(db, row))
}

function connectionRow(row: any) {
  return {
    connection_id: row.connection_id,
    provider: row.provider,
    name: row.name,
    status: row.status,
    error: row.error ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function connectionPick(db: any, connectionId: string) {
  const row = db.query("SELECT * FROM provider_connections_current WHERE connection_id = ?").get(connectionId) as any
  return row ? row as ProviderConnection : null
}

function connectionList(db: any, provider: string) {
  return db.query("SELECT * FROM provider_connections_current WHERE provider = ? ORDER BY updated_at DESC").all(provider) as ProviderConnection[]
}

function listConnections(db: any, provider?: string | null) {
  const sql = provider
    ? "SELECT * FROM provider_connections_current WHERE provider = ? ORDER BY updated_at DESC"
    : "SELECT * FROM provider_connections_current ORDER BY updated_at DESC"
  const rows = provider ? db.query(sql).all(provider) : db.query(sql).all()
  return (rows as any[]).map(connectionRow)
}

function authRequired(provider: ProviderName, message?: string) {
  const name = provider === "github" ? "GitHub" : "Linear"
  const hint =
    provider === "github"
      ? "Sign in with shared auth, use `gh auth login`, or keep a legacy WorkGraph token as a fallback."
      : "Sign in with shared auth or keep a legacy WorkGraph token as a fallback."
  return {
    kind: "auth_required" as const,
    provider,
    message: message || `WorkGraph could not find ${name} credentials for this import.`,
    hint,
  }
}

async function resolve(
  db: any,
  provider: ProviderName | undefined,
  connectionId: string | undefined,
  auth?: ProviderAuthResolver,
) {
  if (connectionId) {
    const row = connectionPick(db, connectionId)
    if (!row) return { error: "missing_connection" as const }
    return { row, source: "legacy_connection" as const, stored: true }
  }
  if (!provider) return { error: "missing_provider" as const }
  const next = auth ? await auth(provider) : null
  if (next?.token?.trim()) {
    const now = new Date().toISOString()
    return {
      row: {
        connection_id: `auth_${provider}`,
        provider,
        name: next.name?.trim() || `${provider} auth`,
        token: next.token.trim(),
        status: "connected",
        error: null,
        created_at: now,
        updated_at: now,
      } satisfies ProviderConnection,
      source: next.source,
      stored: false,
    }
  }
  const row = connectionList(db, provider)[0]
  if (row) return { row, source: "legacy_connection" as const, stored: true }
  return { error: "auth_required" as const }
}

function summary(
  row: ProviderConnection,
  mode: ProviderQueryMode,
  params: Record<string, any>,
  items: Array<{ title: string; provider_url?: string; external_key?: string }>,
) {
  const head = [
    `# Imported ${row.provider === "github" ? "GitHub" : "Linear"} work`,
    "",
    `- Connection: ${row.name}`,
    `- Query mode: ${mode.replaceAll("_", " ")}`,
  ]
  const meta = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `- ${key.replaceAll("_", " ")}: ${String(value)}`)
  const list = items.map((item) =>
    item.provider_url
      ? `- [${item.external_key || item.title}](${item.provider_url}) ${item.title}`
      : `- ${item.external_key || item.title}`,
  )
  return [...head, ...meta, "", "## Selected items", ...list].join("\n")
}

function importTitle(row: ProviderConnection, mode: ProviderQueryMode) {
  const name = row.provider === "github" ? "GitHub" : "Linear"
  const label = mode.replaceAll("_", " ")
  return `${name} import · ${label}`
}

function json(value: string | null | undefined) {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function norm(value: string | null | undefined) {
  const next = value?.trim()
  return next ? next : null
}

function repoQuery(value: string | null | undefined) {
  const next = norm(value)
  return next === "__all__" ? null : next
}

const providerName = z.enum(["github", "linear"])
const queryMode = z.enum(["single_item", "assigned_to_me", "updated_since", "project_or_team"])

function cwd(c: any) {
  return dir(c.req.query("directory") || c.req.header("x-opencode-directory")) ?? process.cwd()
}

function current(c: any) {
  return dir(c.req.query("directory") || c.req.header("x-opencode-directory")) ?? null
}

function call(c: any) {
  const root = cwd(c)
  return async () => {
    throw new Error(`Execution adapter is not configured for ${root}`)
  }
}

function launch(c: any, execution?: ExecutionAdapter, base?: string | null) {
  const root = base ?? cwd(c)
  if (!execution) return call(c)
  return (
    prompt: string,
    runId: string,
    nodeId: string,
    meta?: {
      role?: string
      kind?: string
      title?: string
      directory?: string
    },
  ) =>
    execution.launch({
      run_id: runId,
      node_id: nodeId,
      prompt,
      role: meta?.role ?? "developer",
      kind: meta?.kind ?? "task",
      title: meta?.title ?? nodeId,
      directory: meta?.directory ?? root,
    })
}

function role(labels: string[]) {
  if (labels.includes("qa")) return "qa"
  if (labels.includes("review")) return "code_reviewer"
  if (labels.includes("design")) return "designer"
  if (labels.includes("pm")) return "pm"
  return "developer"
}

function touchRun(
  db: any,
  runId: string,
  meta: {
    runtime_type?: string
    session_id?: string | null
    pty_id?: string | null
    directory?: string | null
  },
) {
  const now = new Date().toISOString()
  const row = db.query("SELECT run_id FROM run_exec_current WHERE run_id = ?").get(runId) as any
  if (!row) {
    db.run(
      "INSERT INTO run_exec_current (run_id, runtime_type, session_id, pty_id, directory, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [runId, meta.runtime_type ?? "workspace", meta.session_id ?? null, meta.pty_id ?? null, meta.directory ?? null, now],
    )
    return
  }
  db.run(
    "UPDATE run_exec_current SET runtime_type = ?, session_id = ?, pty_id = ?, directory = ?, updated_at = ? WHERE run_id = ?",
    [meta.runtime_type ?? null, meta.session_id ?? null, meta.pty_id ?? null, meta.directory ?? null, now, runId],
  )
}

function attemptRow(row: any) {
  return {
    attempt_id: row.attempt_id,
    run_id: row.run_id,
    node_id: row.node_id,
    status: row.status,
    runtime_type: row.runtime_type,
    directory: row.directory ?? null,
    worktree_path: row.worktree_path ?? null,
    session_id: row.session_id ?? null,
    pty_id: row.pty_id ?? null,
    started_at: row.started_at,
    finished_at: row.finished_at ?? null,
    last_heartbeat_at: row.last_heartbeat_at,
  }
}

function attemptForItem(db: any, itemId: string) {
  const row = db.query(
    `SELECT a.*
     FROM attempts_current a
     INNER JOIN run_node_items_current n ON n.run_id = a.run_id AND n.node_id = a.node_id
     WHERE n.work_item_id = ?
     ORDER BY CASE WHEN a.status IN ('starting', 'running') THEN 0 ELSE 1 END, a.started_at DESC
     LIMIT 1`,
  ).get(itemId) as any
  return row ? attemptRow(row) : null
}

function attemptsForItem(db: any, itemId: string) {
  return (db.query(
    `SELECT a.*
     FROM attempts_current a
     INNER JOIN run_node_items_current n ON n.run_id = a.run_id AND n.node_id = a.node_id
     WHERE n.work_item_id = ?
     ORDER BY a.started_at DESC`,
  ).all(itemId) as any[]).map(attemptRow)
}

function runsForItem(db: any, itemId: string) {
  return (db.query(
    `SELECT DISTINCT
        r.run_id,
        r.goal,
        r.status,
        r.source_id,
        r.created_at,
        r.updated_at,
        n.node_id,
        COALESCE(
          (SELECT a.runtime_type FROM attempts_current a WHERE a.run_id = n.run_id AND a.node_id = n.node_id ORDER BY a.started_at DESC LIMIT 1),
          x.runtime_type,
          'workspace'
        ) AS runtime_type,
        (SELECT a.attempt_id FROM attempts_current a WHERE a.run_id = n.run_id AND a.node_id = n.node_id ORDER BY a.started_at DESC LIMIT 1) AS attempt_id,
        (SELECT a.status FROM attempts_current a WHERE a.run_id = n.run_id AND a.node_id = n.node_id ORDER BY a.started_at DESC LIMIT 1) AS attempt_status,
        (SELECT a.session_id FROM attempts_current a WHERE a.run_id = n.run_id AND a.node_id = n.node_id ORDER BY a.started_at DESC LIMIT 1) AS session_id,
        (SELECT a.pty_id FROM attempts_current a WHERE a.run_id = n.run_id AND a.node_id = n.node_id ORDER BY a.started_at DESC LIMIT 1) AS pty_id,
        (SELECT a.directory FROM attempts_current a WHERE a.run_id = n.run_id AND a.node_id = n.node_id ORDER BY a.started_at DESC LIMIT 1) AS directory,
        (SELECT a.worktree_path FROM attempts_current a WHERE a.run_id = n.run_id AND a.node_id = n.node_id ORDER BY a.started_at DESC LIMIT 1) AS worktree_path
      FROM run_node_items_current n
      INNER JOIN runs_current r ON r.run_id = n.run_id
      LEFT JOIN run_exec_current x ON x.run_id = r.run_id
      WHERE n.work_item_id = ?
      ORDER BY COALESCE(
        (SELECT a.started_at FROM attempts_current a WHERE a.run_id = n.run_id AND a.node_id = n.node_id ORDER BY a.started_at DESC LIMIT 1),
        r.updated_at,
        r.created_at,
        ''
      ) DESC`,
  ).all(itemId) as any[]).map((row) => ({
    run_id: row.run_id,
    goal: row.goal,
    status: row.status,
    slice_id: row.source_id ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    runtime_type: row.runtime_type ?? "workspace",
    attempt_id: row.attempt_id ?? null,
    attempt_status: row.attempt_status ?? null,
    session_id: row.session_id ?? null,
    pty_id: row.pty_id ?? null,
    directory: row.directory ?? null,
    worktree_path: row.worktree_path ?? null,
    node_id: row.node_id,
  }))
}

function eventsForItem(db: any, itemId: string) {
  const runs = runsForItem(db, itemId)
  if (!runs.length) return []
  const ids = new Map<string, Set<string>>()
  for (const run of runs) {
    const set = ids.get(run.run_id) ?? new Set<string>()
    set.add(run.node_id)
    ids.set(run.run_id, set)
  }
  return Array.from(ids.entries())
    .flatMap(([runId, set]) =>
      (db.query("SELECT * FROM events WHERE run_id = ? ORDER BY stream_seq ASC").all(runId) as any[]).filter((event) => {
        try {
          const data = JSON.parse(event.payload_json)
          return typeof data === "object" && data && typeof data.node_id === "string" && set.has(data.node_id)
        } catch {
          return false
        }
      }),
    )
    .sort((a, b) => {
      if (a.created_at === b.created_at) return a.stream_seq - b.stream_seq
      return a.created_at.localeCompare(b.created_at)
    })
}

function artifactsForItem(db: any, itemId: string) {
  return eventsForItem(db, itemId)
    .filter((event) => event.type === "artifact_created")
    .flatMap((event) => {
      try {
        const data = JSON.parse(event.payload_json)
        if (typeof data !== "object" || !data) return []
        if (typeof data.artifact_id !== "string" || typeof data.content !== "string") return []
        return [{
          artifact_id: data.artifact_id,
          node_id: typeof data.node_id === "string" ? data.node_id : null,
          type: typeof data.type === "string" ? data.type : "artifact",
          content: data.content,
          created_at: event.created_at,
        }]
      } catch {
        return []
      }
    })
}

function descendantArtifacts(db: any, itemId: string) {
  const ids = getWorkGraph().getDescendants(itemId).map((item) => item.id)
  const seen = new Set<string>()
  return ids
    .flatMap((id) => artifactsForItem(db, id))
    .filter((artifact) => {
      if (seen.has(artifact.artifact_id)) return false
      seen.add(artifact.artifact_id)
      return true
    })
}

function life(item: WorkItem) {
  if (item.deletedAt) return "deleted"
  if (item.archivedAt) return "archived"
  return "active"
}

function on(item: WorkItem) {
  return !item.archivedAt && !item.deletedAt
}

function row(db: any, item: WorkItem) {
  const wg = getWorkGraph()
  const blocked = wg.getBlockedBy(item.id)
  const blocking = wg.getBlocking(item.id)
  const slices = wg.getSlices(item.id)
    .map((sliceId) => slicePick(db, sliceId))
    .filter(Boolean)
  const runs = runsForItem(db, item.id)
  const last = attemptForItem(db, item.id)
  const live = runs.find((run) => run.attempt_status === "running" || run.attempt_status === "starting") ?? null
  const isBlocked = item.nodeType !== "mission" && on(item) && item.status === "open" && blocked.some((dep) => dep.status !== "done")
  const ready = item.nodeType !== "mission" && on(item) && item.status === "open" && !isBlocked && !live
  return {
    item_id: item.id,
    parent_id: item.parentId ?? null,
    repo_ref: item.repoRef ?? null,
    repo_label: item.repoLabel ?? null,
    node_type: item.nodeType,
    title: item.title,
    description: item.description,
    status: item.status,
    lifecycle: life(item),
    archived_at: item.archivedAt ?? null,
    archived_reason: item.archivedReason ?? null,
    deleted_at: item.deletedAt ?? null,
    deleted_reason: item.deletedReason ?? null,
    labels: item.labels,
    context: item.context ?? null,
    provider: item.provider ?? null,
    provider_meta: item.providerMeta ?? null,
    provider_url: item.providerUrl ?? null,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    blocked: isBlocked,
    ready,
    blockers: blocked.length,
    dependents: blocking.length,
    slices: slices.map((slice) => ({ slice_id: slice.slice_id, title: slice.title, kind: slice.kind, status: slice.status })),
    active_run_id: live?.run_id ?? null,
    latest_run_id: runs[0]?.run_id ?? null,
    runtime_type: live?.runtime_type ?? last?.runtime_type ?? null,
    attempt_id: live?.attempt_id ?? last?.attempt_id ?? null,
    attempt_status: live?.attempt_status ?? last?.status ?? null,
    session_id: live?.session_id ?? last?.session_id ?? null,
    pty_id: live?.pty_id ?? last?.pty_id ?? null,
    directory: live?.directory ?? last?.directory ?? null,
    worktree_path: live?.worktree_path ?? last?.worktree_path ?? null,
  }
}

function apply(
  list: WorkItem[],
  db: any,
  query: {
    status?: string | null
    lifecycle?: string | null
    slice_id?: string | null
    run_id?: string | null
    repo_ref?: string | null
    attention?: string | null
    search?: string | null
  },
) {
  const wg = getWorkGraph()
  let items = list.filter((item) => {
    if (query.lifecycle === "all") return true
    if (query.lifecycle === "archived") return !!item.archivedAt && !item.deletedAt
    if (query.lifecycle === "deleted") return !!item.deletedAt
    return on(item)
  })
  if (query.slice_id) {
    const ids = new Set(wg.getBySlice(query.slice_id).map((item) => item.id))
    items = items.filter((item) => ids.has(item.id))
  }
  if (query.run_id) {
    const ids = new Set(
      (db.query("SELECT DISTINCT work_item_id FROM run_node_items_current WHERE run_id = ?").all(query.run_id) as any[])
        .map((row) => row.work_item_id),
    )
    items = items.filter((item) => ids.has(item.id))
  }
  if (query.repo_ref === "__unbound__") {
    items = items.filter((item) => !item.repoRef)
  }
  if (query.repo_ref && query.repo_ref !== "__unbound__") {
    items = items.filter((item) => item.repoRef === query.repo_ref)
  }
  if (query.search) {
    const txt = query.search.toLowerCase()
    items = items.filter((item) =>
      item.title.toLowerCase().includes(txt) || item.description.toLowerCase().includes(txt),
    )
  }
  if (!query.status && !query.attention) return items
  return items.filter((item) => {
    const info = row(db, item)
    if (query.attention === "true" && !info.session_id) return false
    if (!query.status || query.status === "all") return true
    if (query.status === "ready") return info.ready
    if (query.status === "active") return item.status === "in_progress" || !!info.active_run_id
    if (query.status === "blocked") return info.blocked
    if (query.status === "done") return item.status === "done"
    return item.status === query.status
  })
}

function blockers(db: any, itemId: string) {
  const wg = getWorkGraph()
  return wg.getBlockedBy(itemId).map((item) => row(db, item))
}

function dependents(db: any, itemId: string) {
  const wg = getWorkGraph()
  return wg.getBlocking(itemId).map((item) => row(db, item))
}

function children(db: any, itemId: string) {
  return getWorkGraph().getChildren(itemId).map((item) => row(db, item))
}

function descendants(db: any, itemId: string) {
  return getWorkGraph()
    .getDescendants(itemId)
    .filter((item) => item.nodeType !== "mission")
    .map((item) => row(db, item))
}

function descendantScratchpads(itemId: string) {
  const ids = new Set(getWorkGraph().getDescendants(itemId).map((item) => item.id))
  return getWorkGraph()
    .getScratchpads()
    .filter((entry) => ids.has(entry.workItemId))
}

function synthesis(db: any, itemId: string) {
  const item = getWorkGraph().getChildren(itemId).find((child) => child.nodeType === "synthesis")
  if (!item) return null
  return row(db, item)
}

function synthesisArtifact(db: any, itemId: string) {
  const item = getWorkGraph().getChildren(itemId).find((child) => child.nodeType === "synthesis")
  if (!item) return null
  return artifactsForItem(db, item.id).at(-1) ?? null
}

function activeRuns(db: any) {
  return new Set(
    (db.query(
      `SELECT DISTINCT n.work_item_id
       FROM run_node_items_current n
       INNER JOIN runs_current r ON r.run_id = n.run_id
       WHERE r.status = 'executing'`,
    ).all() as any[]).map((row) => row.work_item_id),
  )
}

function subtree(wg: ReturnType<typeof getWorkGraph>, rootId: string) {
  const root = wg.get(rootId)
  if (root?.nodeType === "mission") {
    return wg.getDescendants(rootId).filter((item) => on(item) && item.status !== "done" && item.nodeType !== "mission")
  }
  const seen = new Set<string>()
  const walk = (id: string): WorkItem[] => {
    if (seen.has(id)) return []
    seen.add(id)
    const item = wg.get(id)
    if (!item || !on(item) || item.status === "done") return []
    return [item, ...wg.getBlocking(id).flatMap((child) => walk(child.id))]
  }
  return walk(rootId)
}

function focus(wg: ReturnType<typeof getWorkGraph>, db: any, rootId: string) {
  const items = subtree(wg, rootId)
  const ids = new Set(items.map((item) => item.id))
  const busy = activeRuns(db)
  const out = new Map<string, { item_id: string; title: string; blocked_item_ids: Set<string> }>()
  const mark = (blocker: WorkItem, itemId: string) => {
    const row = out.get(blocker.id) ?? { item_id: blocker.id, title: blocker.title, blocked_item_ids: new Set<string>() }
    row.blocked_item_ids.add(itemId)
    out.set(blocker.id, row)
  }
  for (const item of items) {
    if (busy.has(item.id) || item.status === "in_progress") {
      mark(item, item.id)
    }
    for (const dep of wg.getBlockedBy(item.id).filter((node) => node.status !== "done")) {
      if (ids.has(dep.id)) continue
      mark(dep, item.id)
    }
  }
  const hold = new Set(
    Array.from(out.values()).flatMap((item) => Array.from(item.blocked_item_ids)),
  )
  const ready = items.filter((item) =>
    item.status === "open" &&
    !busy.has(item.id) &&
    !hold.has(item.id) &&
    wg.getBlockedBy(item.id).every((dep) => dep.status === "done"),
  )
  return {
    items,
    ready,
    hold,
    blocked: Array.from(out.values()).map((item) => ({
      item_id: item.item_id,
      title: item.title,
      blocked_item_ids: Array.from(item.blocked_item_ids),
    })),
  }
}

function snapshot(
  db: any,
  runId: string,
  items: WorkItem[],
  hold = new Set<string>(),
) {
  const map = new Map<string, string>()
  for (const item of items) {
    const nodeId = `node_${ulid()}`
    map.set(item.id, nodeId)
    const status = hold.has(item.id) ? "blocked" : "pending"
    db.run(
      "INSERT INTO nodes_current (node_id, run_id, role, kind, title, node_type, status, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [nodeId, runId, role(item.labels), item.labels[0] ?? item.nodeType, item.title || item.id, item.nodeType, status, 0],
    )
    db.run(
      "INSERT INTO run_node_items_current (run_id, node_id, work_item_id) VALUES (?, ?, ?)",
      [runId, nodeId, item.id],
    )
    const body = item.description || `Execute task: ${item.title || item.id}`
    db.run(
      "INSERT INTO scratchpad_entries (id, run_id, node_id, content, created_at, expires_at, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        `sp_${ulid()}`,
        runId,
        nodeId,
        body,
        new Date().toISOString(),
        new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        new TextEncoder().encode(body).length,
      ],
    )
  }

  const ids = new Set(items.map((item) => item.id))
  const edges = getWorkGraph().getState().edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))
  for (const edge of edges) {
    const source = map.get(edge.source)
    const target = map.get(edge.target)
    if (!source || !target) continue
    db.run(
      "INSERT INTO dependency_edges_current (id, run_id, source_id, target_id, type) VALUES (?, ?, ?, ?, ?)",
      [`edge_${ulid()}`, runId, source, target, "depends_on"],
    )
  }

  return new Map(
    items
      .map((item) => {
        const nodeId = map.get(item.id)
        if (!nodeId) return null
        return [nodeId, item.id] as const
      })
      .filter(Boolean),
  )
}

function writeBlockers(
  db: any,
  runId: string,
  blocked: Array<{ item_id: string; title: string; blocked_item_ids: string[] }>,
  map: Map<string, string>,
) {
  db.run("DELETE FROM run_blockers_current WHERE run_id = ?", [runId])
  for (const item of blocked) {
    for (const target of item.blocked_item_ids) {
      const nodeId = map.get(target)
      if (!nodeId) continue
      db.run(
        "INSERT INTO run_blockers_current (run_id, work_item_id, target_node_id, title) VALUES (?, ?, ?, ?)",
        [runId, item.item_id, nodeId, item.title],
      )
    }
  }
}

function deps(wg: ReturnType<typeof getWorkGraph>, itemId: string) {
  return wg.getBlocking(itemId).filter((item) => on(item) && item.status !== "done")
}

function live(db: any, itemId: string) {
  return db.query(
    `SELECT a.run_id, a.node_id, a.session_id, a.pty_id, a.directory, a.worktree_path
     FROM attempts_current a
     INNER JOIN run_node_items_current n ON n.run_id = a.run_id AND n.node_id = a.node_id
     WHERE n.work_item_id = ? AND a.finished_at IS NULL
     ORDER BY a.started_at DESC`,
  ).all(itemId) as Array<{
    run_id: string
    node_id: string
    session_id: string | null
    pty_id: string | null
    directory: string | null
    worktree_path: string | null
  }>
}

export function graphRouter(
  db: any,
  eventStore: IEventStore,
  execution?: ExecutionAdapter,
  providers?: ProviderFactory,
  auth?: ProviderAuthResolver,
  repos?: RepoBindingResolver,
) {
  const router = new Hono()

  let tick = 0
  let memo: Promise<Awaited<ReturnType<RepoBindingResolver>>> | null = null
  const syncRepos = async (force = false) => {
    if (!repos) {
      await backfillRepos(db, [])
      return []
    }
    const now = Date.now()
    if (!force && memo && now - tick < 10_000) return memo
    tick = now
    memo = repos().then(async (list) => {
      await backfillRepos(db, list)
      return list
    })
    return memo
  }

  const archive = async (c: any) => {
    const wg = getWorkGraph()
    const id = c.req.param("id")
    const item = wg.get(id)
    if (!item) return c.json({ error: "Work item not found" }, 404)
    if (item.deletedAt) return c.json({ error: "Deleted work item cannot be archived" }, 400)
    const reason = c.req.query("reason") || undefined
    const rows = live(db, id)
    const runs = new Set<string>()
    for (const row of rows) {
      cancelNodeExecution(db, row.run_id, row.node_id, "archived")
      runs.add(row.run_id)
      await execution?.cleanup?.({
        run_id: row.run_id,
        node_id: row.node_id,
        session_id: row.session_id,
        pty_id: row.pty_id,
        directory: row.directory,
        worktree_path: row.worktree_path,
        mode: "archive",
      })
    }
    const next = wg.archive(id, reason)
    for (const runId of runs) {
      await reconcileExecution(db, runId, launch(c, execution))
    }
    return c.json({ item: row(db, next) })
  }

  router.get("/graph/providers/connections", async (c) => {
    return c.json(listConnections(db, c.req.query("provider")))
  })

  router.post(
    "/graph/providers/connections",
    zValidator(
      "json",
      z.object({
        provider: providerName,
        name: z.string().optional(),
        token: z.string().min(1),
      }),
    ),
    async (c) => {
      const body = c.req.valid("json")
      const now = new Date().toISOString()
      const rows = connectionList(db, body.provider)
      const prev = rows[0]
      const connectionId = prev?.connection_id ?? `conn_${ulid()}`
      const next: ProviderConnection = {
        connection_id: connectionId,
        provider: body.provider,
        name: body.name?.trim() || `${body.provider} ${connectionId.slice(-6)}`,
        token: body.token.trim(),
        status: "connected",
        error: null,
        created_at: now,
        updated_at: now,
      }
      try {
        await validate(next, providers)
      } catch (err) {
        next.status = "error"
        next.error = (err as Error).message
      }
      if (prev) {
        db.run(
          "UPDATE provider_connections_current SET name = ?, token = ?, status = ?, error = ?, updated_at = ? WHERE connection_id = ?",
          [next.name, next.token, next.status, next.error, next.updated_at, next.connection_id],
        )
        db.run("DELETE FROM provider_connections_current WHERE provider = ? AND connection_id != ?", [body.provider, next.connection_id])
        if (next.status === "error") return c.json(connectionRow(next), 400)
        return c.json(connectionRow(next))
      }
      db.run(
        "INSERT INTO provider_connections_current (connection_id, provider, name, token, status, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [next.connection_id, next.provider, next.name, next.token, next.status, next.error, next.created_at, next.updated_at],
      )
      if (next.status === "error") return c.json(connectionRow(next), 400)
      return c.json(connectionRow(next), 201)
    },
  )

  router.post("/graph/providers/connections/:id/validate", async (c) => {
    const conn = connectionPick(db, c.req.param("id"))
    if (!conn) return c.json({ error: "Connection not found" }, 404)
    try {
      const info = await validate(conn, providers)
      db.run(
        "UPDATE provider_connections_current SET status = ?, error = ?, updated_at = ? WHERE connection_id = ?",
        ["connected", null, new Date().toISOString(), conn.connection_id],
      )
      return c.json({ ...connectionRow({ ...conn, status: "connected", error: null }), label: info.label ?? null })
    } catch (err) {
      const msg = (err as Error).message
      db.run(
        "UPDATE provider_connections_current SET status = ?, error = ?, updated_at = ? WHERE connection_id = ?",
        ["error", msg, new Date().toISOString(), conn.connection_id],
      )
      return c.json({ ...connectionRow({ ...conn, status: "error", error: msg }), label: null }, 400)
    }
  })

  router.delete("/graph/providers/connections/:id", async (c) => {
    const conn = connectionPick(db, c.req.param("id"))
    if (!conn) return c.json({ error: "Connection not found" }, 404)
    db.run("DELETE FROM provider_connections_current WHERE connection_id = ?", [conn.connection_id])
    return c.json({ deleted: true })
  })

  router.post(
    "/graph/providers/query",
    zValidator(
      "json",
      z
        .object({
          provider: providerName.optional(),
          connection_id: z.string().min(1).optional(),
          mode: queryMode,
          limit: z.number().int().min(1).max(50).optional(),
          query: z.record(z.string(), z.any()).optional(),
          repo_ref: z.string().optional(),
          repo_label: z.string().optional(),
        })
        .superRefine((value, ctx) => {
          if (value.provider || value.connection_id) return
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "provider or connection_id is required",
            path: ["provider"],
          })
        }),
    ),
    async (c) => {
      const body = c.req.valid("json")
      const conn = await resolve(db, body.provider, body.connection_id, auth)
      if ("error" in conn) {
        if (conn.error === "missing_connection") return c.json({ error: "Connection not found" }, 404)
        if (conn.error === "missing_provider") return c.json({ error: "Provider is required" }, 400)
        return c.json(authRequired(body.provider!), 200)
      }
      const items = await preview(
        conn.row,
        body.mode,
        { ...(body.query ?? {}), limit: body.limit ?? body.query?.limit },
        providers,
      )
      return c.json({
        kind: "preview",
        provider: conn.row.provider,
        mode: body.mode,
        items,
      })
    },
  )

  router.post(
    "/graph/providers/import",
    zValidator(
      "json",
      z
        .object({
          provider: providerName.optional(),
          connection_id: z.string().min(1).optional(),
          mode: queryMode,
          title: z.string().optional(),
          goal: z.string().optional(),
          repo_ref: z.string().optional(),
          repo_label: z.string().optional(),
          directory: z.string().optional(),
          query: z.record(z.string(), z.any()).optional(),
          items: z
            .array(
              z.object({
                provider_meta: z.record(z.string(), z.any()),
                title: z.string(),
                provider_url: z.string().optional(),
                external_key: z.string().optional(),
              }),
            )
            .optional(),
        })
        .superRefine((value, ctx) => {
          if (value.provider || value.connection_id) return
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "provider or connection_id is required",
            path: ["provider"],
          })
        }),
    ),
    async (c) => {
      const body = c.req.valid("json")
      await syncRepos()
      const conn = await resolve(db, body.provider, body.connection_id, auth)
      if ("error" in conn) {
        if (conn.error === "missing_connection") return c.json({ error: "Connection not found" }, 404)
        if (conn.error === "missing_provider") return c.json({ error: "Provider is required" }, 400)
        return c.json(authRequired(body.provider!), 200)
      }
      const picked = body.items?.length
        ? body.items
        : await preview(conn.row, body.mode, body.query ?? {}, providers)
      if (!picked.length) return c.json({ error: "No provider items selected" }, 400)
      const inferred = Array.from(
        new Map(
          picked
            .map((item) => inferRepo(conn.row.provider, item.provider_meta, item.provider_url))
            .filter((item): item is NonNullable<ReturnType<typeof inferRepo>> => !!item)
            .map((item) => [item.repo_ref, item]),
        ).values(),
      )
      const repo = body.repo_ref
        ? { repo_ref: body.repo_ref, repo_label: body.repo_label ?? body.repo_ref }
        : inferred.length === 1
          ? inferred[0]
          : null
      if (!repo && conn.row.provider !== "github") {
        return c.json({ error: "repo_ref is required when the provider query does not identify a single repo" }, 400)
      }
      if (!repo && conn.row.provider === "github") {
        return c.json({ error: "Selected issues span multiple repos. Choose one repo or narrow the selection." }, 400)
      }
      if (repo && inferred.some((item) => item.repo_ref !== repo.repo_ref)) {
        return c.json({ error: "Imported items must stay within one repo" }, 400)
      }
      const now = new Date().toISOString()
      const sliceId = `src_${ulid()}`
      const title = body.title?.trim() || importTitle(conn.row, body.mode)
      const goal = body.goal?.trim() || `Work through imported ${conn.row.provider} tasks`
      const content = summary(conn.row, body.mode, body.query ?? {}, picked)
      db.run(
        "INSERT INTO sources_current (source_id, goal, kind, title, content, source_path, status, plan_run_id, last_run_id, error, provider, provider_connection_id, import_mode, import_query, mission_item_id, repo_ref, repo_label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          sliceId,
          goal,
          "issue",
          title,
          content,
          null,
          "planned",
          null,
          null,
          null,
          conn.row.provider,
          conn.stored ? conn.row.connection_id : null,
          body.mode,
          JSON.stringify(body.query ?? {}),
          null,
          repo.repo_ref,
          repo.repo_label,
          now,
          now,
        ],
      )
      const wg = getWorkGraph()
      const mission = wg.create({
        sourceId: sliceId,
        repoRef: repo.repo_ref,
        repoLabel: repo.repo_label,
        title,
        description: content,
        nodeType: "mission",
        labels: ["mission", "import", conn.row.provider],
        context: `source:${sliceId} provider:${conn.row.provider}${conn.stored ? ` connection:${conn.row.connection_id}` : ""}`,
      })
      slicePatch(db, sliceId, { mission_item_id: mission.id })
      const next = await wg.importSlice(
        adapter(conn.row, providers),
        picked.map((item) => item.provider_meta),
        { sourceId: sliceId, parentId: mission.id, repoRef: repo.repo_ref, repoLabel: repo.repo_label },
      )
      wg.ensureSynthesis(mission.id)
      return c.json({
        kind: "imported",
        slice: slicePick(db, sliceId),
        mission: row(db, mission),
        items: next.map((item) => row(db, item)),
      }, 201)
    },
  )

  router.get("/graph/items", async (c) => {
    await syncRepos()
    const wg = getWorkGraph()
    const items = apply(wg.getAll(), db, {
      status: c.req.query("status"),
      lifecycle: c.req.query("lifecycle"),
      slice_id: c.req.query("slice_id"),
      run_id: c.req.query("run_id"),
      repo_ref: repoQuery(c.req.query("repo_ref")),
      attention: c.req.query("attention"),
      search: c.req.query("search"),
    })
    return c.json(items.map((item) => row(db, item)))
  })

  router.get("/graph/items/:id", async (c) => {
    await syncRepos()
    const wg = getWorkGraph()
    const item = wg.get(c.req.param("id"))
    if (!item) return c.json({ error: "Work item not found" }, 404)
    return c.json({
      item: row(db, item),
      blockers: blockers(db, item.id),
      dependents: dependents(db, item.id),
      children: children(db, item.id),
      descendants: descendants(db, item.id),
      synthesis: synthesis(db, item.id),
      synthesis_artifact: synthesisArtifact(db, item.id),
      slices: getWorkGraph().getSlices(item.id).map((sliceId) => slicePick(db, sliceId)).filter(Boolean),
      runs: runsForItem(db, item.id),
      attempts: attemptsForItem(db, item.id),
      trace: eventsForItem(db, item.id),
      artifacts: artifactsForItem(db, item.id),
      descendant_artifacts: descendantArtifacts(db, item.id),
      scratchpads: wg.getScratchpads(item.id),
      descendant_scratchpads: descendantScratchpads(item.id),
    })
  })

  router.get("/graph/items/:id/archive", archive)
  router.post("/graph/items/:id/archive", archive)

  router.delete("/graph/items/:id", async (c) => {
    const wg = getWorkGraph()
    const id = c.req.param("id")
    const item = wg.get(id)
    if (!item) return c.json({ error: "Work item not found" }, 404)
    const nextDeps = deps(wg, id)
    if (nextDeps.length > 0) {
      return c.json({
        error: "Work item has active dependents and must be archived instead of deleted",
        dependents: nextDeps.map((dep) => ({ item_id: dep.id, title: dep.title })),
      }, 409)
    }
    const reason = c.req.query("reason") || undefined
    if (!item.archivedAt) {
      wg.archive(id, reason)
    }
    const rows = live(db, id)
    const runs = new Set<string>()
    for (const row of rows) {
      cancelNodeExecution(db, row.run_id, row.node_id, "deleted")
      runs.add(row.run_id)
      await execution?.cleanup?.({
        run_id: row.run_id,
        node_id: row.node_id,
        session_id: row.session_id,
        pty_id: row.pty_id,
        directory: row.directory,
        worktree_path: row.worktree_path,
        mode: "delete",
      })
    }
    wg.remove(id)
    if (reason) {
      wg.update(id, { deletedReason: reason })
    }
    const next = wg.get(id)
    for (const runId of runs) {
      await reconcileExecution(db, runId, launch(c, execution))
    }
    return c.json({ item: next ? row(db, next) : null })
  })

  router.get("/graph/slices", async (c) => {
    await syncRepos()
    return c.json(listSlices(db, repoQuery(c.req.query("repo_ref"))))
  })

  router.get("/graph/repos", async (c) => {
    const list = await syncRepos(true)
    return c.json(buckets(db, list))
  })

  router.get("/graph/slices/:slice_id/events", async (c) => {
    const slice = slicePick(db, c.req.param("slice_id"))
    if (!slice) return c.json({ error: "Slice not found" }, 404)
    if (!slice.trace_run_id) return c.json([])
    const rows = db
      .query("SELECT * FROM events WHERE run_id = ? ORDER BY stream_seq ASC")
      .all(slice.trace_run_id)
    return c.json(rows)
  })

  router.post(
    "/graph/slices",
    zValidator(
      "json",
      z.object({
        goal: z.string().optional(),
        kind: z.enum(["spec", "doc"]).optional(),
        title: z.string().optional(),
        content: z.string().min(1),
        source_path: z.string().optional(),
        repo_ref: z.string().optional(),
        repo_label: z.string().optional(),
        directory: z.string().optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid("json")
      await syncRepos()
      const kind = body.kind ?? "spec"
      const title = body.title?.trim() || `${kind.toUpperCase()} slice`
      const goal = body.goal?.trim() || `Plan work for ${title}`
      const repo = body.repo_ref
        ? { repo_ref: body.repo_ref, repo_label: body.repo_label ?? body.repo_ref }
        : await (async () => {
            const dir = body.directory ?? current(c)
            if (!dir) return null
            const binds = await syncRepos()
            const hit = binds.find((item) => dir === item.project_root || dir.startsWith(`${item.project_root}/`))
            if (hit) return hit
            return resolveRepoDir(dir)
          })()
      if (!repo) return c.json({ error: "repo_ref is required when the current directory cannot be resolved to a repo" }, 400)
      const now = new Date().toISOString()
      const sliceId = `src_${ulid()}`
      db.run(
        "INSERT INTO sources_current (source_id, goal, kind, title, content, source_path, status, plan_run_id, last_run_id, error, repo_ref, repo_label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [sliceId, goal, kind, title, body.content, body.source_path ?? null, "draft", null, null, null, repo.repo_ref, repo.repo_label, now, now],
      )
      return c.json(slicePick(db, sliceId), 201)
    },
  )

  router.post("/graph/slices/:slice_id/plan", zValidator("json", z.object({ directory: z.string().optional() })), async (c) => {
    if (!execution) return c.json({ error: "Execution adapter not configured" }, 503)
    await syncRepos()
    const body = c.req.valid("json")
    const slice = slicePick(db, c.req.param("slice_id"))
    if (!slice) return c.json({ error: "Slice not found" }, 404)
    if (slice.status === "planning" || slice.status === "executing") {
      return c.json({ error: `Slice is already ${slice.status}` }, 400)
    }
    const runId = `run_${ulid()}`
    await createRunInDb(
      db,
      eventStore,
      runId,
      slice.goal,
      "active",
      {
        kind: slice.kind,
        title: slice.title,
        content: slice.content,
        source_path: slice.source_path ?? undefined,
      },
      slice.slice_id,
    )
    slicePatch(db, slice.slice_id, {
      status: "planning",
      plan_run_id: runId,
      error: null,
    })
    const spin = launch(c, execution, body.directory ?? current(c) ?? process.cwd())
    startOrchestration(
      db,
      runId,
      slice.goal,
      spin,
      undefined,
      { auto_execute: false },
    ).catch((err) => {
      console.error(`[graph] plan error for ${slice.slice_id}:`, err)
    })
    return c.json(slicePick(db, slice.slice_id), 202)
  })

  router.post(
    "/graph/runs",
    zValidator(
      "json",
      z.object({
        root_item_id: z.string().optional(),
        item_ids: z.array(z.string()).optional(),
        slice_id: z.string().optional(),
        run_id: z.string().optional(),
        directory: z.string().optional(),
        status: z.string().optional(),
        search: z.string().optional(),
        goal: z.string().optional(),
      }),
    ),
    async (c) => {
      if (!execution) return c.json({ error: "Execution adapter not configured" }, 503)
      await syncRepos()
      const body = c.req.valid("json")
      const wg = getWorkGraph()
      const mission = body.root_item_id ? wg.get(body.root_item_id) : null
      const tree = mission ? focus(wg, db, mission.id) : null
      const pool = tree
        ? tree.items
        : apply(wg.getAll(), db, {
            status: body.status ?? null,
            slice_id: body.slice_id ?? null,
            run_id: body.run_id ?? null,
            search: body.search ?? null,
          })
      const picked = tree
        ? tree.items
        : body.item_ids?.length
          ? pool.filter((item) => body.item_ids?.includes(item.id))
          : pool
      const work = picked.filter((item) => item.nodeType !== "mission")
      if (!work.length) {
        return c.json({ created: false, ready_ids: [], blocked: [], skipped: [] })
      }
      const refs = Array.from(new Set(work.map((item) => item.repoRef).filter(Boolean)))
      if (work.some((item) => !item.repoRef)) {
        return c.json({ error: "All selected work must be bound to one repo before execution" }, 400)
      }
      if (refs.length > 1) {
        return c.json({ error: "Execution cannot span multiple repos" }, 400)
      }
      const execDir = body.directory ?? current(c)
      if (!execDir) {
        return c.json({ error: "directory is required to execute repo-scoped work" }, 400)
      }

      const busy = activeRuns(db)
      const ready = tree
        ? tree.ready
        : work.filter((item) =>
            item.status === "open" &&
            !busy.has(item.id) &&
            wg.getBlockedBy(item.id).every((dep) => dep.status === "done"),
          )
      const skipped = tree
        ? []
        : work
            .filter((item) => !ready.some((node) => node.id === item.id))
            .map((item) => ({
              item_id: item.id,
              title: item.title,
              blocked_by: wg.getBlockedBy(item.id).filter((dep) => dep.status !== "done").map((dep) => dep.id),
              active: busy.has(item.id),
              status: item.status,
            }))
      const blocked = tree?.blocked ?? []
      if (!ready.length && !blocked.length) {
        return c.json({ created: false, ready_ids: [], blocked: [], skipped })
      }

      const slice = body.slice_id ? slicePick(db, body.slice_id) : null
      const goal = body.goal?.trim() || mission?.title || slice?.goal || `Execute ${work.length} work item${work.length === 1 ? "" : "s"}`
      const runId = `run_${ulid()}`
      await createRunInDb(
        db,
        eventStore,
        runId,
        goal,
        "active",
        slice
          ? {
              kind: slice.kind,
              title: slice.title,
              content: slice.content,
              source_path: slice.source_path ?? undefined,
            }
          : undefined,
        slice?.slice_id,
      )
      touchRun(db, runId, {
        runtime_type: "workspace",
        directory: execDir,
      })
      const map = snapshot(db, runId, work, tree?.hold)
      writeBlockers(db, runId, blocked, map)
      if (slice) {
        slicePatch(db, slice.slice_id, {
          status: "executing",
          last_run_id: runId,
          error: null,
        })
      }
      const spin = launch(c, execution, execDir)
      startExecution(db, runId, goal, spin, map).catch((err) => {
        console.error(`[graph] execute error for ${runId}:`, err)
      })
      return c.json({
        created: true,
        run_id: runId,
        ready_ids: ready.map((item) => item.id),
        blocked,
        skipped,
      }, 202)
    },
  )

  return router
}

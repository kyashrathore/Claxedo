import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { ulid } from "ulid"
import { cancelAttempt, reconcileAttempts, startAttempts } from "../sdk/attempts"
import type { ProviderName, ProviderPreview } from "../connectors/interface"
import { getWorkGraph } from "../model/registry"
import { dir } from "../dir"
import type { ExecutionAdapter } from "../execution"
import { adapter, preview, validate, type ProviderAuthResolver, type ProviderConnection, type ProviderFactory } from "../providers"
import { buckets, inferRepo, resolveRepoDir, type RepoBindingResolver } from "../repo"
import type { SourceKind, RunSourceInput } from "../model/types"
import { createRepoSync } from "../sdk/repo-sync"
import { archiveWorkItem } from "../sdk/archive-service"
import type { ISliceStore } from "../sdk/slices"
import type { IConnectionStore } from "../sdk/connections"
import type { IExecutionStore } from "../sdk/execution-store"
import type { IRunStore } from "../sdk/runs"
import type { IEventStore } from "../substrate/event-store"
import { sqlite, type SqliteInput } from "../sqlite"
import {
  itemRow,
  applyItemFilters,
  runsForItem,
  attemptsForItem,
  eventsForItem,
  artifactsForItem,
  descendantArtifacts,
  descendantScratchpads,
  synthesisItem,
  synthesisArtifact,
  liveExecutions,
  activeDependents,
  focusSubtree,
  createSnapshot,
  writeBlockers,
  writeInternalBlockers,
  activeRunItemIds,
  touchRun,
  paginateItems,
} from "../sdk/graph-query"

// ---------------------------------------------------------------------------
// Auth resolution helper
// ---------------------------------------------------------------------------

function authRequired(provider: ProviderName, message?: string) {
  const name = provider === "github" ? "GitHub" : "Linear"
  const hint =
    provider === "github"
      ? "Connect GitHub through Composio and store the connected account id as the WorkGraph provider token."
      : "Sign in with shared auth or keep a legacy WorkGraph token as a fallback."
  return { kind: "auth_required" as const, provider, message: message || `WorkGraph could not find ${name} credentials for this import.`, hint }
}

async function resolveAuth(
  connStore: IConnectionStore,
  provider: ProviderName | undefined,
  connectionId: string | undefined,
  auth?: ProviderAuthResolver,
): Promise<{ error: "missing_connection" | "missing_provider" | "auth_required" } | { row: ProviderConnection; source: string; stored: boolean }> {
  if (connectionId) {
    const row = connStore.get(connectionId)
    if (!row) return { error: "missing_connection" }
    return { row: row as unknown as ProviderConnection, source: "legacy_connection", stored: true }
  }
  if (!provider) return { error: "missing_provider" }
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
  const row = connStore.listByProvider(provider)[0]
  if (row) return { row: row as unknown as ProviderConnection, source: "legacy_connection", stored: true }
  return { error: "auth_required" }
}

// ---------------------------------------------------------------------------
// Provider import helpers
// ---------------------------------------------------------------------------

function importSummary(
  row: ProviderConnection,
  mode: string,
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
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `- ${k.replaceAll("_", " ")}: ${String(v)}`)
  const list = items.map((item) =>
    item.provider_url
      ? `- [${item.external_key || item.title}](${item.provider_url}) ${item.title}`
      : `- ${item.external_key || item.title}`,
  )
  return [...head, ...meta, "", "## Selected items", ...list].join("\n")
}

function importTitle(row: ProviderConnection, mode: string) {
  return `${row.provider === "github" ? "GitHub" : "Linear"} import · ${mode.replaceAll("_", " ")}`
}

// ---------------------------------------------------------------------------
// Request context helpers
// ---------------------------------------------------------------------------

const providerName = z.enum(["github", "linear"])
const queryMode = z.enum(["single_item", "assigned_to_me", "updated_since", "project_or_team"])

function cwd(c: any) {
  return dir(c.req.query("directory") || c.req.header("x-opencode-directory")) ?? process.cwd()
}

function current(c: any) {
  return dir(c.req.query("directory") || c.req.header("x-opencode-directory")) ?? null
}

function repoQuery(value: string | null | undefined) {
  const next = value?.trim()
  return (next && next !== "__all__") ? next : null
}

function launch(c: any, execution?: ExecutionAdapter, base?: string | null) {
  const root = base ?? cwd(c)
  if (!execution) {
    return async () => { throw new Error(`Execution adapter is not configured for ${root}`) }
  }
  return (prompt: string, runId: string, nodeId: string, meta?: { role?: string; kind?: string; title?: string; directory?: string }) =>
    execution.launch({ run_id: runId, node_id: nodeId, prompt, role: meta?.role ?? "developer", kind: meta?.kind ?? "task", title: meta?.title ?? nodeId, directory: meta?.directory ?? root })
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function graphRouter(
  input: SqliteInput,
  executionStore: IExecutionStore,
  runStore: IRunStore,
  eventStore: IEventStore,
  sliceStore: ISliceStore,
  connStore: IConnectionStore,
  execution?: ExecutionAdapter,
  providers?: ProviderFactory,
  auth?: ProviderAuthResolver,
  repos?: RepoBindingResolver,
) {
  const db = sqlite(input)
  const router = new Hono()

  // Helper: emit run_created event + insert run row + optionally attach source.
  // Replaces the old createRunInDb helper that used the broken hash chain.
  async function initRun(
    runId: string,
    goal: string,
    status = "active",
    source?: RunSourceInput,
    sourceId?: string,
  ) {
    const eventId = `evt_${ulid()}`
    await eventStore.append({
      id: eventId,
      run_id: runId,
      stream_id: runId,
      schema_version: 1,
      type: "run_created",
      payload_json: JSON.stringify({ goal, status }),
      actor_type: "user",
      actor_id: "api",
      op_id: `op_${eventId}`,
      created_at: new Date().toISOString(),
    })
    runStore.createRunWithMeta(runId, goal, status, source, sourceId)
  }

  const syncRepos = createRepoSync(db, repos)

  // Shared archive handler used by GET and POST /graph/items/:id/archive
  const archiveHandler = async (c: any) => {
    const result = await archiveWorkItem(
      db,
      c.req.param("id"),
      c.req.query("reason") || undefined,
      executionStore,
      sliceStore,
      launch(c, execution),
      execution,
    )
    if ("error" in result) return c.json({ error: result.error }, result.status)
    return c.json(result)
  }

  // ---------------------------------------------------------------------------
  // Provider connections
  //
  // @deprecated Interim — auth ownership moved to @claxedo/connections; hosts
  // should supply tokens via the `auth` resolver / `github({ getToken })`
  // seam instead of storing them here. These routes stay only while the
  // current app UI uses them; they die in the app-plugin lane.
  // ---------------------------------------------------------------------------

  router.get("/graph/providers/connections", (c) => {
    return c.json(connStore.list(c.req.query("provider")))
  })

  router.post(
    "/graph/providers/connections",
    zValidator("json", z.object({ provider: providerName, name: z.string().optional(), token: z.string().min(1) })),
    async (c) => {
      const body = c.req.valid("json")
      const now = new Date().toISOString()
      const prev = connStore.listByProvider(body.provider)[0]
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
      const stored = connStore.upsert(next)
      const status = stored.status === "error" ? 400 : prev ? 200 : 201
      return c.json(connStore.list(body.provider).find((r) => r.connection_id === stored.connection_id), status as any)
    },
  )

  router.post("/graph/providers/connections/:id/validate", async (c) => {
    const conn = connStore.get(c.req.param("id"))
    if (!conn) return c.json({ error: "Connection not found" }, 404)
    try {
      const info = await validate(conn as unknown as ProviderConnection, providers)
      connStore.updateStatus(conn.connection_id, "connected", null)
      return c.json({ ...connStore.list().find((r) => r.connection_id === conn.connection_id), label: info.label ?? null })
    } catch (err) {
      const msg = (err as Error).message
      connStore.updateStatus(conn.connection_id, "error", msg)
      return c.json({ ...connStore.list().find((r) => r.connection_id === conn.connection_id), label: null }, 400)
    }
  })

  router.delete("/graph/providers/connections/:id", (c) => {
    const conn = connStore.get(c.req.param("id"))
    if (!conn) return c.json({ error: "Connection not found" }, 404)
    connStore.delete(conn.connection_id)
    return c.json({ deleted: true })
  })

  // ---------------------------------------------------------------------------
  // Provider queries & imports
  // ---------------------------------------------------------------------------

  router.post(
    "/graph/providers/query",
    zValidator(
      "json",
      z.object({
        provider: providerName.optional(),
        connection_id: z.string().min(1).optional(),
        mode: queryMode,
        limit: z.number().int().min(1).max(50).optional(),
        query: z.record(z.string(), z.any()).optional(),
        repo_ref: z.string().optional(),
        repo_label: z.string().optional(),
      }).superRefine((v, ctx) => {
        if (!v.provider && !v.connection_id) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "provider or connection_id is required", path: ["provider"] })
      }),
    ),
    async (c) => {
      const body = c.req.valid("json")
      const conn = await resolveAuth(connStore, body.provider, body.connection_id, auth)
      if ("error" in conn) {
        if (conn.error === "missing_connection") return c.json({ error: "Connection not found" }, 404)
        if (conn.error === "missing_provider") return c.json({ error: "Provider is required" }, 400)
        return c.json(authRequired(body.provider!), 200)
      }
      const items = await preview(conn.row, body.mode, { ...(body.query ?? {}), limit: body.limit ?? body.query?.limit }, providers)
      return c.json({ kind: "preview", provider: conn.row.provider, mode: body.mode, items })
    },
  )

  router.post(
    "/graph/providers/import",
    zValidator(
      "json",
      z.object({
        provider: providerName.optional(),
        connection_id: z.string().min(1).optional(),
        mode: queryMode,
        title: z.string().optional(),
        goal: z.string().optional(),
        repo_ref: z.string().optional(),
        repo_label: z.string().optional(),
        directory: z.string().optional(),
        query: z.record(z.string(), z.any()).optional(),
        items: z.array(z.object({
          provider_meta: z.record(z.string(), z.any()),
          title: z.string(),
          provider_url: z.string().optional(),
          external_key: z.string().optional(),
        })).optional(),
      }).superRefine((v, ctx) => {
        if (!v.provider && !v.connection_id) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "provider or connection_id is required", path: ["provider"] })
      }),
    ),
    async (c) => {
      const body = c.req.valid("json")
      await syncRepos()
      const conn = await resolveAuth(connStore, body.provider, body.connection_id, auth)
      if ("error" in conn) {
        if (conn.error === "missing_connection") return c.json({ error: "Connection not found" }, 404)
        if (conn.error === "missing_provider") return c.json({ error: "Provider is required" }, 400)
        return c.json(authRequired(body.provider!), 200)
      }
      const picked = body.items?.length ? body.items : await preview(conn.row, body.mode, body.query ?? {}, providers)
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
        : inferred.length === 1 ? inferred[0] : null
      if (!repo && conn.row.provider !== "github") return c.json({ error: "repo_ref is required when the provider query does not identify a single repo" }, 400)
      if (!repo && conn.row.provider === "github") return c.json({ error: "Selected issues span multiple repos. Choose one repo or narrow the selection." }, 400)
      if (repo && inferred.some((item) => item.repo_ref !== repo.repo_ref)) return c.json({ error: "Imported items must stay within one repo" }, 400)

      const sliceId = `src_${ulid()}`
      const title = body.title?.trim() || importTitle(conn.row, body.mode)
      const goal = body.goal?.trim() || `Work through imported ${conn.row.provider} tasks`
      const content = importSummary(conn.row, body.mode, body.query ?? {}, picked)
      sliceStore.create(sliceId, {
        goal,
        kind: "issue",
        title,
        content,
        status: "planned",
        provider: conn.row.provider,
        provider_connection_id: conn.stored ? conn.row.connection_id : null,
        import_mode: body.mode,
        import_query: JSON.stringify(body.query ?? {}),
        repo_ref: repo!.repo_ref,
        repo_label: repo!.repo_label,
      })
      const wg = getWorkGraph()
      const mission = wg.create({
        sourceId: sliceId,
        repoRef: repo!.repo_ref,
        repoLabel: repo!.repo_label,
        title,
        description: content,
        nodeType: "mission",
        labels: ["mission", "import", conn.row.provider],
        context: `source:${sliceId} provider:${conn.row.provider}${conn.stored ? ` connection:${conn.row.connection_id}` : ""}`,
      })
      sliceStore.update(sliceId, { mission_item_id: mission.id })
      const next = await wg.importSlice(
        adapter(conn.row, providers),
        picked.map((item) => item.provider_meta),
        { sourceId: sliceId, parentId: mission.id, repoRef: repo!.repo_ref, repoLabel: repo!.repo_label },
      )
      wg.ensureSynthesis(mission.id)
      return c.json({
        kind: "imported",
        slice: sliceStore.get(sliceId),
        mission: itemRow(db, mission, sliceStore),
        items: next.map((item) => itemRow(db, item, sliceStore)),
      }, 201)
    },
  )

  // ---------------------------------------------------------------------------
  // Work items
  // ---------------------------------------------------------------------------

  router.get("/graph/items", async (c) => {
    await syncRepos()
    const wg = getWorkGraph()
    const filtered = applyItemFilters(wg.getAll(), db, sliceStore, {
      status: c.req.query("status"),
      lifecycle: c.req.query("lifecycle"),
      slice_id: c.req.query("slice_id"),
      run_id: c.req.query("run_id"),
      repo_ref: repoQuery(c.req.query("repo_ref")),
      attention: c.req.query("attention"),
      search: c.req.query("search"),
    })
    const rows = filtered.map((item) => itemRow(db, item, sliceStore))
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 200)
    return c.json(paginateItems(rows, c.req.query("cursor"), limit))
  })

  router.get("/graph/items/:id", async (c) => {
    await syncRepos()
    const wg = getWorkGraph()
    const item = wg.get(c.req.param("id"))
    if (!item) return c.json({ error: "Work item not found" }, 404)
    return c.json({
      blockers: wg.getBlockedBy(item.id).map((i) => itemRow(db, i, sliceStore)),
      dependents: wg.getBlocking(item.id).map((i) => itemRow(db, i, sliceStore)),
      children: wg.getChildren(item.id).map((i) => itemRow(db, i, sliceStore)),
      descendants: wg.getDescendants(item.id).filter((i) => i.nodeType !== "mission").map((i) => itemRow(db, i, sliceStore)),
      synthesis: synthesisItem(db, item.id, sliceStore),
      slices: wg.getSlices(item.id).map((sliceId) => sliceStore.get(sliceId)).filter(Boolean),
      runs: runsForItem(db, item.id),
      attempts: attemptsForItem(db, item.id),
      trace: eventsForItem(db, item.id),
      scratchpads: wg.getScratchpads(item.id),
      descendant_scratchpads: descendantScratchpads(item.id),
    })
  })

  router.get("/graph/items/:id/artifacts", (c) => {
    const wg = getWorkGraph()
    const item = wg.get(c.req.param("id"))
    if (!item) return c.json({ error: "Work item not found" }, 404)
    return c.json({
      artifacts: artifactsForItem(db, item.id),
      descendant_artifacts: descendantArtifacts(db, item.id),
      synthesis_artifact: synthesisArtifact(db, item.id),
    })
  })

  router.get("/graph/items/:id/archive", archiveHandler)
  router.post("/graph/items/:id/archive", archiveHandler)

  router.delete("/graph/items/:id", async (c) => {
    const wg = getWorkGraph()
    const id = c.req.param("id")
    const item = wg.get(id)
    if (!item) return c.json({ error: "Work item not found" }, 404)
    const nextDeps = activeDependents(wg, id)
    if (nextDeps.length > 0) {
      return c.json({ error: "Work item has active dependents and must be archived instead of deleted", dependents: nextDeps.map((dep) => ({ item_id: dep.id, title: dep.title })) }, 409)
    }
    const reason = c.req.query("reason") || undefined
    if (!item.archivedAt) wg.archive(id, reason)
    const rows = liveExecutions(db, id)
    const runs = new Set<string>()
    for (const row of rows) {
      cancelAttempt(executionStore, row.run_id, row.node_id, "deleted")
      runs.add(row.run_id)
      await execution?.cleanup?.({ run_id: row.run_id, node_id: row.node_id, session_id: row.session_id, pty_id: row.pty_id, directory: row.directory, worktree_path: row.worktree_path, mode: "delete" })
    }
    wg.remove(id)
    if (reason) wg.update(id, { deletedReason: reason })
    const next = wg.get(id)
    for (const runId of runs) await reconcileAttempts(executionStore, runId, launch(c, execution))
    return c.json({ item: next ? itemRow(db, next, sliceStore) : null })
  })

  // ---------------------------------------------------------------------------
  // Slices
  // ---------------------------------------------------------------------------

  router.get("/graph/slices", async (c) => {
    await syncRepos()
    return c.json(sliceStore.list(repoQuery(c.req.query("repo_ref"))))
  })

  router.get("/graph/slices/:slice_id/events", async (c) => {
    const slice = sliceStore.get(c.req.param("slice_id"))
    if (!slice) return c.json({ error: "Slice not found" }, 404)
    if (!slice.trace_run_id) return c.json([])
    const rows = await eventStore.getEvents(slice.trace_run_id)
    return c.json(rows)
  })

  router.post(
    "/graph/slices",
    zValidator("json", z.object({
      goal: z.string().optional(),
      kind: z.enum(["spec", "doc"]).optional(),
      title: z.string().optional(),
      content: z.string().min(1),
      source_path: z.string().optional(),
      repo_ref: z.string().optional(),
      repo_label: z.string().optional(),
      directory: z.string().optional(),
    })),
    async (c) => {
      const body = c.req.valid("json")
      await syncRepos()
      const kind = body.kind ?? "spec"
      const title = body.title?.trim() || `${kind.toUpperCase()} slice`
      const goal = body.goal?.trim() || `Plan work for ${title}`
      const repo = body.repo_ref
        ? { repo_ref: body.repo_ref, repo_label: body.repo_label ?? body.repo_ref }
        : await (async () => {
            const d = body.directory ?? current(c)
            if (!d) return null
            const binds = await syncRepos()
            const hit = binds.find((item) => d === item.project_root || d.startsWith(`${item.project_root}/`))
            if (hit) return hit
            return resolveRepoDir(d)
          })()
      if (!repo) return c.json({ error: "repo_ref is required when the current directory cannot be resolved to a repo" }, 400)
      const sliceId = `src_${ulid()}`
      const slice = sliceStore.create(sliceId, {
        goal,
        kind,
        title,
        content: body.content,
        source_path: body.source_path ?? null,
        status: "draft",
        repo_ref: repo.repo_ref,
        repo_label: repo.repo_label,
      })
      return c.json(slice, 201)
    },
  )

  router.post(
    "/graph/slices/:slice_id/plan",
    zValidator("json", z.object({ directory: z.string().optional() })),
    async (c) => {
      // LLM plan decomposition was removed with the orchestrator
      // (plan 2026-07-06-004). Import or create items and execute them
      // directly via /graph/runs.
      const slice = sliceStore.get(c.req.param("slice_id"))
      if (!slice) return c.json({ error: "Slice not found" }, 404)
      return c.json({ error: "planning_removed", message: "Plan decomposition was removed. Create or import work items and start them directly." }, 410)
    },
  )

  // ---------------------------------------------------------------------------
  // Repos
  // ---------------------------------------------------------------------------

  router.get("/graph/repos", async (c) => {
    const list = await syncRepos(true)
    return c.json(buckets(db, list))
  })

  // ---------------------------------------------------------------------------
  // Execution runs
  // ---------------------------------------------------------------------------

  router.post(
    "/graph/runs",
    zValidator("json", z.object({
      root_item_id: z.string().optional(),
      item_ids: z.array(z.string()).optional(),
      slice_id: z.string().optional(),
      run_id: z.string().optional(),
      directory: z.string().optional(),
      status: z.string().optional(),
      search: z.string().optional(),
      goal: z.string().optional(),
    })),
    async (c) => {
      if (!execution) return c.json({ error: "Execution adapter not configured" }, 503)
      await syncRepos()
      const body = c.req.valid("json")
      const wg = getWorkGraph()
      const mission = body.root_item_id ? wg.get(body.root_item_id) : null
      const tree = mission ? focusSubtree(wg, db, mission.id) : null
      const pool = tree
        ? tree.items
        : applyItemFilters(wg.getAll(), db, sliceStore, { status: body.status ?? null, slice_id: body.slice_id ?? null, run_id: body.run_id ?? null, search: body.search ?? null })
      const picked = tree ? tree.items : body.item_ids?.length ? pool.filter((item) => body.item_ids?.includes(item.id)) : pool
      const work = picked.filter((item) => item.nodeType !== "mission")
      if (!work.length) return c.json({ created: false, ready_ids: [], blocked: [], skipped: [] })

      const refs = Array.from(new Set(work.map((item) => item.repoRef).filter(Boolean)))
      if (work.some((item) => !item.repoRef)) return c.json({ error: "All selected work must be bound to one repo before execution" }, 400)
      if (refs.length > 1) return c.json({ error: "Execution cannot span multiple repos" }, 400)

      const execDir = body.directory ?? current(c)
      if (!execDir) return c.json({ error: "directory is required to execute repo-scoped work" }, 400)

      const busy = activeRunItemIds(db)
      const ready = tree
        ? tree.ready
        : work.filter((item) => item.status === "open" && !busy.has(item.id) && wg.getBlockedBy(item.id).every((dep) => dep.status === "done"))
      const skipped = tree
        ? []
        : work.filter((item) => !ready.some((n) => n.id === item.id)).map((item) => ({
            item_id: item.id,
            title: item.title,
            blocked_by: wg.getBlockedBy(item.id).filter((dep) => dep.status !== "done").map((dep) => dep.id),
            active: busy.has(item.id),
            status: item.status,
          }))
      const blocked = tree?.blocked ?? []
      if (!ready.length && !blocked.length) return c.json({ created: false, ready_ids: [], blocked: [], skipped })

      const slice = body.slice_id ? sliceStore.get(body.slice_id) : null
      const goal = body.goal?.trim() || mission?.title || slice?.goal || `Execute ${work.length} work item${work.length === 1 ? "" : "s"}`
      const runId = `run_${ulid()}`
      await initRun(runId, goal, "active", slice ? { kind: slice.kind as SourceKind, title: slice.title, content: slice.content, source_path: slice.source_path ?? undefined } : undefined, slice?.slice_id)
      touchRun(db, runId, { runtime_type: "workspace", directory: execDir })
      // Flat model: only ready items enter the run — skipped items stay in
      // the inbox untouched. Focused-subtree runs still park outside deps as
      // blocked nodes so the run waits ("blocked") instead of completing.
      // Subtree hold: everything that is not ready yet (in-subtree deps or
      // outside blockers) enters the run as a blocked node and is released
      // when its recorded blockers complete.
      const snapshotItems = tree ? tree.items : ready
      const hold = tree
        ? new Set([
            ...tree.hold,
            ...tree.items
              .filter((item) => item.nodeType !== "mission" && !tree.ready.some((r) => r.id === item.id))
              .map((item) => item.id),
          ])
        : undefined
      const nodeItemMap = createSnapshot(db, runId, snapshotItems, hold)
      writeBlockers(db, runId, blocked, nodeItemMap)
      if (tree && hold) writeInternalBlockers(db, runId, tree.items, hold, nodeItemMap)
      if (slice) sliceStore.update(slice.slice_id, { status: "executing", last_run_id: runId, error: null })
      const spin = launch(c, execution, execDir)
      startAttempts(executionStore, runId, goal, spin).catch((err) => {
        console.error(`[graph] execute error for ${runId}:`, err)
      })
      return c.json({ created: true, run_id: runId, ready_ids: ready.map((item) => item.id), blocked, skipped }, 202)
    },
  )

  return router
}

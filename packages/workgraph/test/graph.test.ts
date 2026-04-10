import { afterEach, beforeEach, describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import { createApp, initializeDb } from "../src/app"
import { ulid as makeId } from "ulid"
import type { WorkGraph } from "../src/model/workgraph"
import { onNodeStatusUpdate, onSessionStopped } from "../src/orchestrator/executor"
import { getWorkGraph, resetWorkGraph } from "../src/orchestrator/workgraph-bridge"
import { ulid } from "ulid"

const repo = {
  repoRef: "github:acme/app",
  repoLabel: "acme/app",
}

function json(body: unknown, headers?: Record<string, string>) {
  return {
    method: "POST" as const,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }
}

function make(wg: WorkGraph, input: Parameters<WorkGraph["create"]>[0]) {
  return wg.create({ ...repo, ...input })
}

describe("Graph routes", () => {
  let db: InstanceType<typeof Database>
  let app: ReturnType<typeof createApp>
  let clean: Array<{ mode: string; run_id: string; node_id: string; worktree_path: string | null }>

  beforeEach(() => {
    resetWorkGraph()
    db = new Database(":memory:")
    initializeDb(db)
    clean = []
    app = createApp(db, {
      execution: {
        launch: async (input) => ({
          id: `sess_${input.node_id}`,
          runtime_type: "workspace",
          session_id: `sess_${input.node_id}`,
          directory: `/repo/${input.node_id}`,
          worktree_path: `/repo/${input.node_id}`,
        }),
        cleanup: async (input) => {
          clean.push({
            mode: input.mode,
            run_id: input.run_id,
            node_id: input.node_id,
            worktree_path: input.worktree_path ?? null,
          })
        },
      },
    })
  })

  afterEach(() => {
    resetWorkGraph()
  })

  it("ingests a slice without creating a run", async () => {
    const res = await app.request(
      "/graph/slices",
      json({
        title: "Growth brief",
        content: "Plan the onboarding revamp.",
        repo_ref: repo.repoRef,
        repo_label: repo.repoLabel,
      }),
    )

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.slice_id).toMatch(/^src_/)
    expect(body.status).toBe("draft")

    const runs = db.query("SELECT COUNT(*) count FROM runs_current").get() as { count: number }
    expect(runs.count).toBe(0)
  })

  it("plans a slice via a hidden run", async () => {
    const res = await app.request(
      "/graph/slices",
      json({
        title: "Ops brief",
        content: "Build the execution graph.",
        repo_ref: repo.repoRef,
        repo_label: repo.repoLabel,
      }),
    )
    const slice = await res.json()

    const plan = await app.request(`/graph/slices/${slice.slice_id}/plan`, json({ directory: "/repo/main" }))
    expect(plan.status).toBe(202)

    const body = await plan.json()
    expect(body.status).toBe("planning")
    expect(body.plan_run_id).toMatch(/^run_/)

    const run = db
      .query("SELECT status, source_id FROM runs_current WHERE run_id = ?")
      .get(body.plan_run_id) as { status: string; source_id: string }
    expect(run.status).toBe("planning")
    expect(run.source_id).toBe(slice.slice_id)

    const slices = await app.request("/graph/slices")
    const listed = await slices.json()
    expect(listed[0]).toEqual(expect.objectContaining({
      slice_id: slice.slice_id,
      plan_run_id: body.plan_run_id,
      trace_run_id: body.plan_run_id,
    }))

    const events = await app.request(`/graph/slices/${slice.slice_id}/events`)
    expect(events.status).toBe(200)
    expect(await events.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "run_created" }),
        expect.objectContaining({ type: "planning_started" }),
      ]),
    )
  })

  it("filters graph items by slice link", async () => {
    const res = await app.request(
      "/graph/slices",
      json({
        title: "Spec",
        content: "Break this into tasks.",
        repo_ref: repo.repoRef,
        repo_label: repo.repoLabel,
      }),
    )
    const slice = await res.json()

    const wg = getWorkGraph()
    const a = make(wg, { sourceId: slice.slice_id, title: "Task A" })
    const b = make(wg, { title: "Task B" })
    wg.addDep(a.id, b.id)

    const graph = await app.request(`/graph/items?slice_id=${slice.slice_id}`)
    expect(graph.status).toBe(200)

    const body = await graph.json()
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toEqual(expect.objectContaining({ item_id: a.id }))
  })

  it("returns mission detail with children and synthesis rollup", async () => {
    const wg = getWorkGraph()
    const mission = make(wg, { title: "Review this codebase", nodeType: "mission", labels: ["mission"] })
    const a = make(wg, { title: "Review API", parentId: mission.id })
    const b = make(wg, { title: "Review UI", parentId: mission.id })
    const synth = wg.ensureSynthesis(mission.id)

    const res = await app.request(`/graph/items/${mission.id}`)
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.item).toEqual(expect.objectContaining({
      item_id: mission.id,
      node_type: "mission",
      parent_id: null,
    }))
    expect(body.children.map((item: { item_id: string }) => item.item_id)).toEqual(expect.arrayContaining([a.id, b.id, synth?.id]))
    expect(body.synthesis).toEqual(expect.objectContaining({ item_id: synth?.id, node_type: "synthesis" }))
    expect(body.descendants.map((item: { item_id: string }) => item.item_id)).toEqual(expect.arrayContaining([a.id, b.id, synth?.id]))
  })

  it("does not create a run when selected work is blocked", async () => {
    const res = await app.request(
      "/graph/slices",
      json({
        title: "Blocked graph",
        content: "Only blocked work.",
        repo_ref: repo.repoRef,
        repo_label: repo.repoLabel,
      }),
    )
    const slice = await res.json()
    db.run(
      "UPDATE sources_current SET status = ?, updated_at = ? WHERE source_id = ?",
      ["planned", new Date().toISOString(), slice.slice_id],
    )

    const wg = getWorkGraph()
    const a = make(wg, { sourceId: slice.slice_id, title: "Task A", status: "in_progress" })
    const b = make(wg, { sourceId: slice.slice_id, title: "Task B" })
    wg.addDep(a.id, b.id)

    const run = await app.request("/graph/runs", json({ item_ids: [b.id] }, { "x-opencode-directory": "/repo/main" }))
    expect(run.status).toBe(200)
    expect(await run.json()).toEqual(
      expect.objectContaining({
        created: false,
        ready_ids: [],
        skipped: [expect.objectContaining({ item_id: b.id })],
      }),
    )
  })

  it("creates an execution run from only the ready subset and stores execution metadata", async () => {
    const res = await app.request(
      "/graph/slices",
      json({
        title: "Mixed graph",
        content: "One ready item and one blocked item.",
        repo_ref: repo.repoRef,
        repo_label: repo.repoLabel,
      }),
    )
    const slice = await res.json()
    db.run(
      "UPDATE sources_current SET status = ?, updated_at = ? WHERE source_id = ?",
      ["planned", new Date().toISOString(), slice.slice_id],
    )

    const wg = getWorkGraph()
    const a = make(wg, { sourceId: slice.slice_id, title: "Task A" })
    const b = make(wg, { sourceId: slice.slice_id, title: "Task B" })
    wg.addDep(a.id, b.id)

    const run = await app.request("/graph/runs", json({ slice_id: slice.slice_id }, { "x-opencode-directory": "/repo/main" }))
    expect(run.status).toBe(202)
    const body = await run.json()
    expect(body.created).toBe(true)
    expect(body.ready_ids).toEqual([a.id])
    expect(body.skipped).toEqual([expect.objectContaining({ item_id: b.id })])

    const nodes = db
      .query("SELECT title, status FROM nodes_current WHERE run_id = ? ORDER BY title ASC")
      .all(body.run_id) as Array<{ title: string; status: string }>
    expect(nodes).toEqual([
      { title: "Task A", status: "active" },
      { title: "Task B", status: "pending" },
    ])

    const links = db
      .query("SELECT work_item_id FROM run_node_items_current WHERE run_id = ? ORDER BY rowid ASC")
      .all(body.run_id) as Array<{ work_item_id: string }>
    expect(links).toEqual([{ work_item_id: a.id }, { work_item_id: b.id }])

    const attempt = db
      .query("SELECT node_id, session_id, worktree_path, status FROM attempts_current WHERE run_id = ?")
      .get(body.run_id) as { node_id: string; session_id: string; worktree_path: string; status: string }
    const meta = db
      .query("SELECT runtime_type, directory FROM run_exec_current WHERE run_id = ?")
      .get(body.run_id) as { runtime_type: string; directory: string }
    expect(meta.runtime_type).toBe("workspace")
    expect(meta.directory).toBe(`/repo/${attempt.node_id}`)
    expect(attempt.session_id).toBe(`sess_${attempt.node_id}`)
    expect(attempt.worktree_path).toBe(`/repo/${attempt.node_id}`)
    expect(attempt.status).toBe("running")
  })

  it("skips mission items when creating an execution run", async () => {
    const wg = getWorkGraph()
    const mission = make(wg, { title: "Review this codebase", nodeType: "mission", labels: ["mission"] })
    const a = make(wg, { title: "Review API", parentId: mission.id })
    const synth = wg.ensureSynthesis(mission.id)

    const run = await app.request("/graph/runs", json({ item_ids: [mission.id, a.id, synth!.id] }, { "x-opencode-directory": "/repo/main" }))
    expect(run.status).toBe(202)
    const body = await run.json()

    const rows = db
      .query("SELECT title, node_type FROM nodes_current WHERE run_id = ? ORDER BY title ASC")
      .all(body.run_id) as Array<{ title: string; node_type: string }>

    expect(rows).toEqual([
      expect.objectContaining({ title: "Review API", node_type: "task" }),
      expect.objectContaining({ title: synth!.title, node_type: "synthesis" }),
    ])
    expect(rows.some((row) => row.title === mission.title)).toBe(false)
  })

  it("rejects mixed-repo execution runs", async () => {
    const wg = getWorkGraph()
    const a = make(wg, { title: "Task A" })
    const b = wg.create({ title: "Task B", repoRef: "github:acme/other", repoLabel: "acme/other" })

    const run = await app.request("/graph/runs", json({ item_ids: [a.id, b.id] }, { "x-opencode-directory": "/repo/main" }))
    expect(run.status).toBe(400)
    expect(await run.json()).toEqual(expect.objectContaining({
      error: expect.stringContaining("multiple repos"),
    }))
  })

  it("creates a focused subtree run and blocks on outside dependencies without expanding scope", async () => {
    const wg = getWorkGraph()
    const a = make(wg, { title: "Task A" })
    const b = make(wg, { title: "Task B" })
    const c = make(wg, { title: "Task C" })
    wg.addDep(a.id, b.id)
    wg.addDep(c.id, b.id)

    const res = await app.request("/graph/runs", json({ root_item_id: a.id }, { "x-opencode-directory": "/repo/main" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.created).toBe(true)
    expect(body.ready_ids).toEqual([a.id])
    expect(body.blocked).toEqual([
      expect.objectContaining({
        item_id: c.id,
        blocked_item_ids: [b.id],
      }),
    ])

    const nodes = db
      .query("SELECT title, status FROM nodes_current WHERE run_id = ? ORDER BY title ASC")
      .all(body.run_id) as Array<{ title: string; status: string }>
    expect(nodes).toEqual([
      { title: "Task A", status: "active" },
      { title: "Task B", status: "blocked" },
    ])

    const node = db
      .query("SELECT node_id FROM run_node_items_current WHERE run_id = ? AND work_item_id = ?")
      .get(body.run_id, a.id) as { node_id: string }

    await onNodeStatusUpdate(
      db,
      body.run_id,
      node.node_id,
      "completed",
      async (prompt, runId, nodeId) => ({
        id: `sess_${nodeId}`,
        runtime_type: "workspace",
        session_id: `sess_${nodeId}`,
        directory: `/repo/${nodeId}`,
        worktree_path: `/repo/${nodeId}`,
      }),
    )

    const run = db
      .query("SELECT status FROM runs_current WHERE run_id = ?")
      .get(body.run_id) as { status: string }
    expect(run.status).toBe("blocked")
  })

  it("marks a session-backed node as failed when its live session dies", async () => {
    const wg = getWorkGraph()
    const a = make(wg, { title: "Task A" })

    const res = await app.request("/graph/runs", json({ root_item_id: a.id }, { "x-opencode-directory": "/repo/main" }))
    expect(res.status).toBe(202)
    const body = await res.json()

    const node = db
      .query("SELECT node_id FROM run_node_items_current WHERE run_id = ? AND work_item_id = ?")
      .get(body.run_id, a.id) as { node_id: string }
    const attempt = db
      .query("SELECT session_id FROM attempts_current WHERE run_id = ? AND node_id = ?")
      .get(body.run_id, node.node_id) as { session_id: string }

    db.run("UPDATE nodes_current SET retry_count = ? WHERE run_id = ? AND node_id = ?", [2, body.run_id, node.node_id])

    const ok = await onSessionStopped(
      db,
      body.run_id,
      node.node_id,
      attempt.session_id,
      async (prompt, runId, nodeId) => ({
        id: `sess_${nodeId}`,
        runtime_type: "workspace",
        session_id: `sess_${nodeId}`,
        directory: `/repo/${nodeId}`,
        worktree_path: `/repo/${nodeId}`,
      }),
      "Session crashed",
    )

    expect(ok).toBe(true)

    const last = db
      .query("SELECT status, finished_at FROM attempts_current WHERE run_id = ? AND node_id = ? ORDER BY started_at DESC LIMIT 1")
      .get(body.run_id, node.node_id) as { status: string; finished_at: string | null }
    const item = await app.request(`/graph/items/${a.id}`)
    const run = db
      .query("SELECT status FROM runs_current WHERE run_id = ?")
      .get(body.run_id) as { status: string }

    expect(last.status).toBe("failed")
    expect(last.finished_at).not.toBeNull()
    expect(run.status).toBe("failed")
    expect((await item.json()).item).toEqual(expect.objectContaining({
      active_run_id: null,
      attempt_status: "failed",
    }))
  })

  it("spawns downstream MCP-triggered work through the execution adapter", async () => {
    const wg = getWorkGraph()
    const a = make(wg, { title: "Task A" })
    const b = make(wg, { title: "Task B" })
    wg.addDep(a.id, b.id)

    const res = await app.request("/graph/runs", json({ item_ids: [a.id, b.id] }, { "x-opencode-directory": "/repo/main" }))
    expect(res.status).toBe(202)
    const body = await res.json()

    const aNode = db
      .query("SELECT node_id FROM run_node_items_current WHERE run_id = ? AND work_item_id = ?")
      .get(body.run_id, a.id) as { node_id: string }
    const bNode = db
      .query("SELECT node_id FROM run_node_items_current WHERE run_id = ? AND work_item_id = ?")
      .get(body.run_id, b.id) as { node_id: string }

    const ok = await app.request(
      "/mcp/tools/call",
      json(
        {
          tool_name: "update_status",
          run_id: body.run_id,
          node_id: aNode.node_id,
          args: {
            node_id: aNode.node_id,
            status: "completed",
          },
        },
        { "x-opencode-directory": "/repo/main" },
      ),
    )

    expect(ok.status).toBe(200)

    const next = db
      .query("SELECT status, session_id, worktree_path FROM attempts_current WHERE run_id = ? AND node_id = ? ORDER BY started_at DESC LIMIT 1")
      .get(body.run_id, bNode.node_id) as { status: string; session_id: string | null; worktree_path: string | null }

    expect(next.status).toBe("running")
    expect(next.session_id).toBe(`sess_${bNode.node_id}`)
    expect(next.worktree_path).toBe(`/repo/${bNode.node_id}`)
  })

  it("returns node-scoped trace for item detail instead of the whole run stream", async () => {
    const wg = getWorkGraph()
    const a = make(wg, { title: "Task A" })
    const b = make(wg, { title: "Task B" })

    const res = await app.request("/graph/runs", json({ item_ids: [a.id, b.id] }, { "x-opencode-directory": "/repo/main" }))
    expect(res.status).toBe(202)
    const body = await res.json()

    const aNode = db
      .query("SELECT node_id FROM run_node_items_current WHERE run_id = ? AND work_item_id = ?")
      .get(body.run_id, a.id) as { node_id: string }
    const bNode = db
      .query("SELECT node_id FROM run_node_items_current WHERE run_id = ? AND work_item_id = ?")
      .get(body.run_id, b.id) as { node_id: string }

    const detail = await app.request(`/graph/items/${a.id}`)
    expect(detail.status).toBe(200)
    const body2 = await detail.json()
    expect(body2.trace.length).toBeGreaterThan(0)
    expect(body2.trace.every((event: { payload_json: string }) => event.payload_json.includes(aNode.node_id))).toBe(true)
    expect(body2.trace.some((event: { payload_json: string }) => event.payload_json.includes(bNode.node_id))).toBe(false)
  })

  it("returns node-scoped artifacts for item detail", async () => {
    const wg = getWorkGraph()
    const a = make(wg, { title: "Task A" })
    const b = make(wg, { title: "Task B" })

    const res = await app.request("/graph/runs", json({ item_ids: [a.id, b.id] }, { "x-opencode-directory": "/repo/main" }))
    expect(res.status).toBe(202)
    const body = await res.json()

    const aNode = db
      .query("SELECT node_id FROM run_node_items_current WHERE run_id = ? AND work_item_id = ?")
      .get(body.run_id, a.id) as { node_id: string }
    const bNode = db
      .query("SELECT node_id FROM run_node_items_current WHERE run_id = ? AND work_item_id = ?")
      .get(body.run_id, b.id) as { node_id: string }

    let seqCounter = 0
    const write = (nodeId: string, content: string) => {
      const id = `evt_${ulid()}`
      seqCounter++
      const seq = seqCounter
      db.run(
        `INSERT INTO events (id, run_id, stream_id, stream_seq, logical_ts, schema_version, type, payload_json, actor_type, actor_id, op_id, prev_hash, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, body.run_id, body.run_id, seq, seq, 1, "artifact_created",
         JSON.stringify({ artifact_id: `artifact_${nodeId}`, node_id: nodeId, type: "file", content }),
         "agent", "test", `op_${id}`, "00000000", makeId(), new Date().toISOString()]
      )
    }

    write(aNode.node_id, "# Plan A")
    write(bNode.node_id, "# Plan B")

    const detail = await app.request(`/graph/items/${a.id}`)
    expect(detail.status).toBe(200)
    const body2 = await detail.json()
    expect(body2.artifacts).toEqual([
      expect.objectContaining({
        node_id: aNode.node_id,
        content: "# Plan A",
      }),
    ])
  })

  it("archives a running item and cancels its live attempt", async () => {
    const wg = getWorkGraph()
    const a = make(wg, { title: "Task A" })

    const run = await app.request("/graph/runs", json({ item_ids: [a.id] }, { "x-opencode-directory": "/repo/main" }))
    const body = await run.json()

    const res = await app.request(`/graph/items/${a.id}/archive`)
    expect(res.status).toBe(200)
    const archived = await res.json()
    expect(archived.item).toEqual(expect.objectContaining({
      item_id: a.id,
      lifecycle: "archived",
      archived_at: expect.any(String),
    }))

    const attempt = db
      .query("SELECT status, finished_at FROM attempts_current WHERE run_id = ? ORDER BY started_at DESC LIMIT 1")
      .get(body.run_id) as { status: string; finished_at: string | null }
    expect(attempt.status).toBe("cancelled")
    expect(attempt.finished_at).toBeTruthy()
    expect(clean).toEqual([
      expect.objectContaining({ mode: "archive", run_id: body.run_id }),
    ])

    const list = await app.request("/graph/items")
    const items = await list.json()
    expect(items.some((item: { item_id: string }) => item.item_id === a.id)).toBe(false)
  })

  it("refuses to delete an item with active dependents", async () => {
    const wg = getWorkGraph()
    const a = make(wg, { title: "Task A" })
    const b = make(wg, { title: "Task B" })
    wg.addDep(a.id, b.id)

    const res = await app.request(`/graph/items/${a.id}`, { method: "DELETE" })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(expect.objectContaining({
      dependents: [{ item_id: b.id, title: "Task B" }],
    }))
  })

  it("deletes an isolated item by tombstoning it and cleaning its owned worktree", async () => {
    const wg = getWorkGraph()
    const a = make(wg, { title: "Task A" })

    const run = await app.request("/graph/runs", json({ item_ids: [a.id] }, { "x-opencode-directory": "/repo/main" }))
    const body = await run.json()

    const res = await app.request(`/graph/items/${a.id}`, { method: "DELETE" })
    expect(res.status).toBe(200)
    expect(wg.get(a.id)).toEqual(expect.objectContaining({
      id: a.id,
      deletedAt: expect.any(String),
    }))
    expect(clean).toEqual([
      expect.objectContaining({
        mode: "delete",
        run_id: body.run_id,
        worktree_path: expect.stringContaining("/repo/"),
      }),
    ])
  })
})

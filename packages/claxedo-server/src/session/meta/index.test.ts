import { afterAll, afterEach, describe, expect, test } from "vitest"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `session-meta-test-${randomUUID().slice(0, 8)}`)
const prev = {
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
}

process.env.CLAXEDO_DATA_DIR = root
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")

const [{
  applySessionMeta,
  deleteSessionMeta,
  listSessionNavigationMetas,
  putSessionMeta,
  sessionMeta,
  sourceChannelSessionCountsByWeek,
  syncSessionMetas,
  taggedSessionMetas,
}, { ClaxedoDB }] = await Promise.all([
  import("@claxedo/server-core/session/meta/index"),
  import("../../platform/db"),
])

afterEach(async () => {
  ClaxedoDB.close()
  await fs.rm(root, { recursive: true, force: true })
})

afterAll(() => {
  process.env.CLAXEDO_DATA_DIR = prev.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_STATE_DIR = prev.CLAXEDO_STATE_DIR
})

describe("session meta", () => {
  test("syncs lineage and merges tags with attachments", async () => {
    await fs.mkdir(root, { recursive: true })
    const ws = {
      id: "ws_1",
      project_id: "proj_1",
      directory: "/tmp/repo",
      kind: "local" as const,
      created_at: 1,
      updated_at: 1,
    }

    await syncSessionMetas(ws, [
      {
        id: "root",
        title: "Root",
        time: { created: 10, updated: 12 },
      },
      {
        id: "child",
        title: "Child",
        parentID: "root",
        time: { created: 11, updated: 13 },
      },
    ])

    await putSessionMeta("child", {
      tags: ["review", "page"],
      attachments: [
        { kind: "review", targetID: "rev_1" },
        { kind: "page", targetID: "page_1" },
      ],
    })

    const hit = await sessionMeta("child")
    expect(hit).toMatchObject({
      sessionRef: "local:/tmp/repo:session:child",
      sessionID: "child",
      workspaceID: "ws_1",
      projectID: "proj_1",
      directory: "/tmp/repo",
      parentID: "root",
      rootID: "root",
      tags: ["page", "review"],
      attachments: [
        { kind: "page", targetID: "page_1" },
        { kind: "review", targetID: "rev_1" },
      ],
    })

    const rows = await applySessionMeta([
      {
        id: "root",
        title: "Root",
        directory: "/tmp/repo",
        time: { created: 10, updated: 12 },
      },
      {
        id: "child",
        title: "Child",
        directory: "/tmp/repo",
        time: { created: 11, updated: 13 },
      },
    ])

    expect(rows).toEqual([
      {
        id: "root",
        title: "Root",
        directory: "/tmp/repo",
        time: { created: 10, updated: 12 },
        projectID: "proj_1",
        rootID: "root",
        tags: [],
        attachments: [],
      },
      {
        id: "child",
        title: "Child",
        directory: "/tmp/repo",
        time: { created: 11, updated: 13 },
        projectID: "proj_1",
        parentID: "root",
        rootID: "root",
        tags: ["page", "review"],
        attachments: [
          { kind: "page", targetID: "page_1" },
          { kind: "review", targetID: "rev_1" },
        ],
      },
    ])
  })

  test("persists and reads a first-class tool sandbox ref verbatim, including a divergent workspace", async () => {
    await fs.mkdir(root, { recursive: true })
    // Session lives in ws_A; its tools run in ws_B (bug (a) coverage).
    await putSessionMeta("divergent", {
      host: "central",
      workspaceID: "ws_A",
      title: "Divergent",
      toolSandbox: { kind: "workspace-runtime", workspaceId: "ws_B", directory: "pkg" },
    })

    expect(await sessionMeta("divergent")).toMatchObject({
      sessionID: "divergent",
      host: "central",
      workspaceID: "ws_A",
      toolSandbox: { kind: "workspace-runtime", workspaceId: "ws_B", directory: "pkg" },
    })
  })

  test("a tags-only put does not clobber a previously stored tool sandbox (bug (b))", async () => {
    await fs.mkdir(root, { recursive: true })
    await putSessionMeta("placed", {
      host: "central",
      workspaceID: "ws_A",
      title: "Placed",
      toolSandbox: { kind: "workspace-runtime", workspaceId: "ws_B" },
    })

    // A real writer rewrites tags with delete-all-reinsert
    // semantics — this must NOT wipe the placement.
    await putSessionMeta("placed", { tags: ["page"] })

    expect(await sessionMeta("placed")).toMatchObject({
      tags: ["page"],
      toolSandbox: { kind: "workspace-runtime", workspaceId: "ws_B" },
    })
  })

  test("explicit null clears a stored tool sandbox", async () => {
    await fs.mkdir(root, { recursive: true })
    await putSessionMeta("clearable", {
      host: "central",
      workspaceID: "ws_A",
      toolSandbox: { kind: "workspace-runtime", workspaceId: "ws_B" },
    })
    expect((await sessionMeta("clearable"))?.toolSandbox).toBeTruthy()

    await putSessionMeta("clearable", { host: "central", workspaceID: "ws_A", toolSandbox: null })

    expect((await sessionMeta("clearable"))?.toolSandbox).toBeUndefined()
  })

  test("deletes a session metadata tree and its associations transactionally", async () => {
    await fs.mkdir(root, { recursive: true })
    await putSessionMeta("sess", {
      tags: ["review"],
      attachments: [{ kind: "review", targetID: "rev_1" }],
    })
    await putSessionMeta("child", {
      parentID: "sess",
      tags: ["child"],
      attachments: [{ kind: "review", targetID: "rev_child" }],
    })
    await putSessionMeta("grandchild", { parentID: "child" })
    await putSessionMeta("unrelated", { tags: ["keep"] })

    expect(await sessionMeta("sess")).toBeTruthy()
    await deleteSessionMeta("sess")
    expect(await sessionMeta("sess")).toBeUndefined()
    expect(await sessionMeta("child")).toBeUndefined()
    expect(await sessionMeta("grandchild")).toBeUndefined()
    expect(await sessionMeta("unrelated")).toBeTruthy()
  })

  test("stores central sessions without workspace or directory", async () => {
    await fs.mkdir(root, { recursive: true })
    await putSessionMeta("central", {
      host: "central",
      title: "Central",
    })

    expect(await sessionMeta("central")).toMatchObject({
      sessionID: "central",
      host: "central",
      title: "Central",
    })
    expect((await sessionMeta("central"))?.directory).toBeUndefined()
    expect((await sessionMeta("central"))?.workspaceID).toBeUndefined()
  })

  test("keeps workspace-sandboxed central sessions under central identity", async () => {
    await fs.mkdir(root, { recursive: true })
    await putSessionMeta("central-workspace", {
      host: "central",
      workspaceID: "ws_1",
      directory: "/tmp/repo",
      title: "Central workspace",
    })

    expect((await listSessionNavigationMetas({ limit: 10 })).map((item) => item.sessionRef))
      .toContain("central:central-workspace")
  })

  test("persists a central Pi model and preserves it across projection sync", async () => {
    await fs.mkdir(root, { recursive: true })
    await putSessionMeta("central-model", {
      host: "central",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    })

    expect((await sessionMeta("central-model"))?.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })

    await putSessionMeta("central-model", { title: "Renamed" })
    expect(await sessionMeta("central-model")).toMatchObject({
      title: "Renamed",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    })

    ClaxedoDB.close()
    expect((await sessionMeta("central-model"))?.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })
  })

  test("explicit null clears central session workspace scope", async () => {
    await fs.mkdir(root, { recursive: true })
    await putSessionMeta("central", {
      host: "central",
      workspaceID: "ws_central",
      title: "Central",
    })
    expect((await sessionMeta("central"))?.workspaceID).toBe("ws_central")

    await putSessionMeta("central", {
      host: "central",
      workspaceID: null,
    })

    expect((await sessionMeta("central"))?.workspaceID).toBeUndefined()
  })

  test("syncSessionMetas treats a workspace snapshot as authoritative", async () => {
    await fs.mkdir(root, { recursive: true })
    const ws = {
      id: "ws_1",
      project_id: "proj_1",
      directory: "/tmp/repo",
      kind: "cloud" as const,
      created_at: 1,
      updated_at: 1,
    }

    await syncSessionMetas(ws, [
      { id: "sess_old", title: "Old", time: { created: 10, updated: 12 } },
      { id: "sess_keep", title: "Keep", time: { created: 11, updated: 13 } },
    ])
    expect(await sessionMeta("sess_old")).toBeTruthy()
    expect(await sessionMeta("sess_keep")).toBeTruthy()

    await syncSessionMetas(ws, [
      { id: "sess_keep", title: "Keep", time: { created: 11, updated: 20 } },
    ])

    expect(await sessionMeta("sess_old")).toBeUndefined()
    expect(await sessionMeta("sess_keep")).toMatchObject({
      sessionID: "sess_keep",
      projectID: "proj_1",
      directory: "/tmp/repo",
    })
  })

  test("syncSessionMetas sweeps stale engine sessions but never central ones", async () => {
    await fs.mkdir(root, { recursive: true })
    const ws = {
      id: "ws_1",
      project_id: "proj_1",
      directory: "/tmp/repo",
      kind: "local" as const,
      created_at: 1,
      updated_at: 1,
    }

    // Two engine sessions, as the embedded runtime's `GET /session?directory=…`
    // reports them.
    await syncSessionMetas(ws, [
      { id: "engine_keep", title: "Keep", time: { created: 10, updated: 12 } },
      { id: "engine_gone", title: "Gone", time: { created: 10, updated: 12 } },
    ])
    // A central/hybrid Pi session in the same workspace, written exactly as
    // `session/runtime.ts` writes one: host "central", null directory.
    await putSessionMeta("pi", {
      host: "central",
      workspaceID: "ws_1",
      directory: null,
      title: "Pi",
      tags: ["global", "global:default", "source-channel:telegram"],
      attachments: [{ kind: "page", targetID: "page_1" }],
    })

    await syncSessionMetas(ws, [
      { id: "engine_keep", title: "Keep", time: { created: 10, updated: 20 } },
    ])

    // The snapshot is authoritative for the engine's own sessions only.
    expect(await sessionMeta("engine_keep")).toBeTruthy()
    expect(await sessionMeta("engine_gone")).toBeUndefined()
    expect(await sessionMeta("pi")).toMatchObject({
      sessionRef: "central:pi",
      host: "central",
      title: "Pi",
      tags: ["global", "global:default", "source-channel:telegram"],
      attachments: [{ kind: "page", targetID: "page_1" }],
    })
  })

  test("syncSessionMetas refuses to sweep on an empty snapshot", async () => {
    await fs.mkdir(root, { recursive: true })
    const ws = {
      id: "ws_1",
      project_id: "proj_1",
      directory: "/tmp/repo",
      kind: "local" as const,
      created_at: 1,
      updated_at: 1,
    }

    await syncSessionMetas(ws, [
      { id: "engine_a", title: "A", time: { created: 10, updated: 12 } },
      { id: "engine_b", title: "B", time: { created: 10, updated: 12 } },
    ])
    await putSessionMeta("engine_a", { tags: ["global", "global:default"] })

    // A restart, a race with the runtime's first apply, or a body that merely
    // parsed as `[]` is absence of evidence, not evidence of absence.
    await syncSessionMetas(ws, [])

    expect(await sessionMeta("engine_a")).toMatchObject({
      sessionID: "engine_a",
      tags: ["global", "global:default"],
    })
    expect(await sessionMeta("engine_b")).toBeTruthy()
    expect(ClaxedoDB.raw().prepare(`
      SELECT COUNT(*) AS count FROM claxedo_session_tag
    `).get()).toEqual({ count: 2 })
  })

  test("a session ref change carries its tags and attachments to the new ref", async () => {
    await fs.mkdir(root, { recursive: true })
    const workspace = {
      id: "ws_local",
      project_id: "proj_local",
      directory: "/tmp/local-repo",
      created_at: 1,
      updated_at: 1,
    }

    // The pre-`Workspace.kind` shape: a local workspace's sessions stored under
    // a `workspace:` ref, with pins and attachments joined to it.
    await syncSessionMetas({ ...workspace, kind: "cloud" }, [
      { id: "sess", title: "Sess", time: { created: 10, updated: 12 } },
    ])
    await putSessionMeta("sess", {
      tags: ["global", "global:default", "source-channel:telegram"],
      attachments: [{ kind: "page", targetID: "page_1" }],
    })
    expect((await sessionMeta("sess"))?.sessionRef).toBe("workspace:ws_local:session:sess")

    // The upgraded build re-derives the ref from the authoritative kind.
    await putSessionMeta("sess", { ws: { ...workspace, kind: "local" as const }, title: "Renamed" })

    expect(await sessionMeta("sess")).toMatchObject({
      sessionRef: "local:/tmp/local-repo:session:sess",
      title: "Renamed",
      createdAt: 10,
      tags: ["global", "global:default", "source-channel:telegram"],
      attachments: [{ kind: "page", targetID: "page_1" }],
    })
    expect(ClaxedoDB.raw().prepare(`
      SELECT session_ref FROM claxedo_session_meta WHERE session_id = ?
    `).all("sess")).toEqual([
      { session_ref: "local:/tmp/local-repo:session:sess" },
    ])
    expect(ClaxedoDB.raw().prepare(`
      SELECT DISTINCT session_ref FROM claxedo_session_tag
      UNION SELECT DISTINCT session_ref FROM claxedo_session_attachment
    `).all()).toEqual([
      { session_ref: "local:/tmp/local-repo:session:sess" },
    ])

    // The old ref never becomes "stale", so the next reconcile deletes nothing.
    await syncSessionMetas({ ...workspace, kind: "local" as const }, [
      { id: "sess", title: "Renamed", time: { created: 10, updated: 30 } },
    ])

    expect(await sessionMeta("sess")).toMatchObject({
      sessionRef: "local:/tmp/local-repo:session:sess",
      tags: ["global", "global:default", "source-channel:telegram"],
      attachments: [{ kind: "page", targetID: "page_1" }],
    })
  })

  test("a ref change merges a database the previous build already half-migrated", async () => {
    await fs.mkdir(root, { recursive: true })
    const workspace = {
      id: "ws_local",
      project_id: "proj_local",
      directory: "/tmp/local-repo",
      created_at: 1,
      updated_at: 1,
    }

    await syncSessionMetas({ ...workspace, kind: "cloud" }, [
      { id: "sess", title: "Sess", time: { created: 10, updated: 12 } },
    ])
    await putSessionMeta("sess", { tags: ["global", "global:default"] })
    // What the shipped build left behind: a bare row already inserted under the
    // new ref, carrying one of the tags, while the old row still holds them all.
    ClaxedoDB.raw().prepare(`
      INSERT INTO claxedo_session_meta (session_ref, session_id, workspace_id, project_id, host, directory, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("local:/tmp/local-repo:session:sess", "sess", "ws_local", "proj_local", "workspace", "/tmp/local-repo", 10, 12)
    ClaxedoDB.raw().prepare(`
      INSERT INTO claxedo_session_tag (session_ref, session_id, tag, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run("local:/tmp/local-repo:session:sess", "sess", "global", 1, 1)

    await putSessionMeta("sess", { ws: { ...workspace, kind: "local" as const } })

    expect(ClaxedoDB.raw().prepare(`
      SELECT session_ref FROM claxedo_session_meta WHERE session_id = ?
    `).all("sess")).toEqual([
      { session_ref: "local:/tmp/local-repo:session:sess" },
    ])
    expect(await sessionMeta("sess")).toMatchObject({
      sessionRef: "local:/tmp/local-repo:session:sess",
      tags: ["global", "global:default"],
    })
  })

  test("syncSessionMetas migrates a local workspace away from a hosted session ref", async () => {
    await fs.mkdir(root, { recursive: true })
    const workspace = {
      id: "ws_local",
      project_id: "proj_local",
      directory: "/tmp/local-repo",
      created_at: 1,
      updated_at: 1,
    }
    const sessions = [
      { id: "sess_local", title: "Local", time: { created: 10, updated: 12 } },
    ]

    await syncSessionMetas({ ...workspace, kind: "cloud" }, sessions)
    expect((await sessionMeta("sess_local"))?.sessionRef).toBe("workspace:ws_local:session:sess_local")

    await syncSessionMetas({ ...workspace, kind: "local" }, sessions)

    expect(await sessionMeta("sess_local")).toMatchObject({
      sessionRef: "local:/tmp/local-repo:session:sess_local",
      workspaceID: "ws_local",
    })
    expect(ClaxedoDB.raw().prepare(`
      SELECT session_ref FROM claxedo_session_meta WHERE session_id = ?
    `).all("sess_local")).toEqual([
      { session_ref: "local:/tmp/local-repo:session:sess_local" },
    ])
  })

  test("lists tagged global sessions and keeps hidden ones out of default view", async () => {
    await fs.mkdir(root, { recursive: true })
    await putSessionMeta("visible", {
      directory: "/tmp/global/visible",
      title: "Visible",
      tags: ["global", "global:default"],
    })
    await putSessionMeta("hidden", {
      directory: "/tmp/global/hidden",
      title: "Hidden",
      tags: ["global"],
    })

    expect((await taggedSessionMetas(["global"])).map((item) => item.sessionID)).toEqual(["visible"])
    expect((await taggedSessionMetas(["global"], { includeHidden: true })).map((item) => item.sessionID)).toEqual([
      "hidden",
      "visible",
    ])
  })

  test("counts source-channel sessions by UTC week for demand gates", async () => {
    await fs.mkdir(root, { recursive: true })
    await putSessionMeta("telegram-1", {
      host: "central",
      title: "Telegram 1",
      tags: ["source-channel:telegram"],
    })
    await putSessionMeta("telegram-2", {
      host: "central",
      title: "Telegram 2",
      tags: ["source-channel:telegram"],
    })
    await putSessionMeta("github-1", {
      host: "central",
      title: "GitHub 1",
      tags: ["source-channel:github"],
    })

    const counts = await sourceChannelSessionCountsByWeek()

    expect(counts).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: "telegram", count: 2 }),
      expect.objectContaining({ channel: "github", count: 1 }),
    ]))
  })

  test("lists session navigation pages with keyset ordering and archive filtering before limit", async () => {
    await fs.mkdir(root, { recursive: true })
    const ws = {
      id: "ws_1",
      project_id: "proj_1",
      directory: "/tmp/repo",
      kind: "local" as const,
      created_at: 1,
      updated_at: 1,
    }
    await syncSessionMetas(ws, [
      { id: "ses_archived", title: "Archived", time: { created: 1, updated: 50, archived: 60 } },
      { id: "ses_c", title: "C", time: { created: 1, updated: 30 } },
      { id: "ses_b", title: "B", time: { created: 1, updated: 30 } },
      { id: "ses_a", title: "A", time: { created: 1, updated: 20 } },
    ])

    const first = await listSessionNavigationMetas({
      directory: "/tmp/repo",
      archived: "active",
      limit: 2,
    })
    expect(first.map((item) => item.sessionID)).toEqual(["ses_c", "ses_b"])

    const next = await listSessionNavigationMetas({
      directory: "/tmp/repo",
      archived: "active",
      limit: 2,
      cursor: {
        updatedAt: 30,
        sessionID: "ses_b",
        sessionRef: "local:/tmp/repo:session:ses_b",
      },
    })
    expect(next.map((item) => item.sessionID)).toEqual(["ses_a"])
  })

  test("filters session navigation pages by status tags before limit", async () => {
    await fs.mkdir(root, { recursive: true })
    const ws = {
      id: "ws_1",
      project_id: "proj_1",
      directory: "/tmp/repo",
      kind: "local" as const,
      created_at: 1,
      updated_at: 1,
    }
    await syncSessionMetas(ws, [
      { id: "ses_newer", title: "Newer", time: { created: 1, updated: 50 } },
      { id: "ses_review", title: "Review", time: { created: 1, updated: 40 } },
    ])
    ClaxedoDB.raw().prepare(`
      INSERT INTO claxedo_session_tag (session_ref, session_id, tag, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run("local:/tmp/repo:session:ses_review", "ses_review", "review", 1, 1)

    const rows = await listSessionNavigationMetas({
      directory: "/tmp/repo",
      archived: "active",
      status: ["review"],
      limit: 1,
    })

    expect(rows.map((item) => item.sessionID)).toEqual(["ses_review"])
  })

  test("keeps duplicate session ids isolated by workspace in navigation pages", async () => {
    await fs.mkdir(root, { recursive: true })
    await syncSessionMetas({
      id: "ws_1",
      project_id: "proj_1",
      directory: "/tmp/repo-a",
      kind: "local" as const,
      created_at: 1,
      updated_at: 1,
    }, [
      { id: "shared", title: "A", time: { created: 1, updated: 20 } },
    ])
    await syncSessionMetas({
      id: "ws_2",
      project_id: "proj_2",
      directory: "/tmp/repo-b",
      kind: "local" as const,
      created_at: 1,
      updated_at: 1,
    }, [
      { id: "shared", title: "B", time: { created: 1, updated: 30 } },
    ])

    expect((await listSessionNavigationMetas({
      archived: "active",
      limit: 10,
    })).map((item) => ({
      sessionRef: item.sessionRef,
      sessionID: item.sessionID,
      title: item.title,
    }))).toEqual([
      { sessionRef: "local:/tmp/repo-b:session:shared", sessionID: "shared", title: "B" },
      { sessionRef: "local:/tmp/repo-a:session:shared", sessionID: "shared", title: "A" },
    ])

    await putSessionMeta("shared", {
      ws: {
        id: "ws_1",
        project_id: "proj_1",
        directory: "/tmp/repo-a",
        kind: "local" as const,
        created_at: 1,
        updated_at: 1,
      },
      archived: 40,
    })

    expect((await listSessionNavigationMetas({
      archived: "active",
      limit: 10,
    })).map((item) => item.sessionRef)).toEqual(["local:/tmp/repo-b:session:shared"])
  })

  test("creates session navigation indexes for common updated-time views", async () => {
    await fs.mkdir(root, { recursive: true })
    await putSessionMeta("ses_index", { directory: "/tmp/repo" })

    const indexes = (ClaxedoDB.raw().prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index'
      AND name LIKE 'claxedo_session_meta_%_archive_updated_idx'
      ORDER BY name
    `).all() as Array<{ name: string }>).map((item) => item.name)

    expect(indexes).toEqual([
      "claxedo_session_meta_directory_archive_updated_idx",
      "claxedo_session_meta_project_archive_updated_idx",
      "claxedo_session_meta_workspace_archive_updated_idx",
    ])
  })

  test.each([
    ["model_provider_id", "anthropic"],
    ["model_id", "claude-sonnet-4-5"],
  ])("reports partial model configuration when only %s is stored", async (column, value) => {
    await fs.mkdir(root, { recursive: true })
    await putSessionMeta("partial-model", { host: "central" })
    ClaxedoDB.raw().prepare(`UPDATE claxedo_session_meta SET ${column} = ? WHERE session_id = ?`).run(value, "partial-model")

    await expect(sessionMeta("partial-model")).rejects.toThrow("incomplete model configuration")
  })

  test("putSessionMeta preserves updated_at when rewriting the same identity fields", async () => {
    await fs.mkdir(root, { recursive: true })
    await putSessionMeta("stable", {
      directory: "/tmp/repo",
      title: "Stable",
      createdAt: 1_000,
      updatedAt: 2_000,
    })
    expect((await sessionMeta("stable"))?.updatedAt).toBe(2_000)
    await putSessionMeta("stable", {
      directory: "/tmp/repo",
      title: "Stable",
    })
    const after = await sessionMeta("stable")
    expect(after?.updatedAt).toBe(2_000)
    expect(after?.createdAt).toBe(1_000)
  })

  test("putSessionMeta bumps updated_at when the title changes", async () => {
    await fs.mkdir(root, { recursive: true })
    await putSessionMeta("renamed", {
      directory: "/tmp/repo",
      title: "Before",
      createdAt: 1_000,
      updatedAt: 2_000,
    })
    await putSessionMeta("renamed", {
      directory: "/tmp/repo",
      title: "After",
    })
    const after = await sessionMeta("renamed")
    expect(after?.title).toBe("After")
    expect(after?.updatedAt).toBeGreaterThan(2_000)
  })

  test("listSessionNavigationMetas supports created_desc order", async () => {
    await fs.mkdir(root, { recursive: true })
    await putSessionMeta("older", {
      directory: "/tmp/repo",
      title: "1. Older",
      createdAt: 1_000,
      updatedAt: 9_000,
    })
    await putSessionMeta("newer", {
      directory: "/tmp/repo",
      title: "2. Newer",
      createdAt: 2_000,
      updatedAt: 3_000,
    })
    const rows = await listSessionNavigationMetas({
      directory: "/tmp/repo",
      archived: "active",
      sort: "created_desc",
      limit: 10,
    })
    expect(rows.map((row) => row.sessionID)).toEqual(["newer", "older"])
  })
})

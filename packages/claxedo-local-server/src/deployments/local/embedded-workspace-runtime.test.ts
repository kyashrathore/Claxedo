import { afterEach, describe, expect, test } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import {
  configureEmbeddedWorkspaceRuntime,
  cursorTranscriptRoot,
  ensureEmbeddedWorkspaceRuntime,
  releaseEmbeddedWorkspaceRuntime,
  shutdownEmbeddedWorkspaceRuntimes,
  syncEmbeddedWorkspaceRuntimeAgentExtensions,
} from "./embedded-workspace-runtime"
import type { OpencodeEvent } from "../../opencode/events"
import type { OpenCodeRequestFn } from "@claxedo/server-core/opencode/engine"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { localWorkspaceRuntime } from "@claxedo/server-core/workspace/local-runtime-port"

async function makeWorkspaceRoot(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const project = path.join(root, "project")
  await fs.mkdir(project, { recursive: true })
  return { root, project }
}

function workspace(id: string, directory: string): Workspace {
  return {
    id,
    directory,
    kind: "local",
    created_at: 1,
    updated_at: 1,
  }
}

// apply() writes Agent Extension replay state under the HOST data dir (keyed by
// workspace id), never into the workspace checkout, so its presence is what
// distinguishes config mode "sync" (applied) from "skip".
async function appliedStateExists(workspaceId: string) {
  return await fs
    .stat(path.join(
      process.env.CLAXEDO_DATA_DIR!,
      "agent-extensions",
      "workspaces",
      workspaceId,
      "installed.json",
    ))
    .then(() => true)
    .catch(() => false)
}

// The invariant that motivated moving state out of the checkout: an apply must
// leave the user's source tree byte-for-byte untouched.
async function workspaceIsClean(directory: string) {
  const generated = await Promise.all([".agent-extensions", ".workspace-runtime"].map((entry) =>
    fs.stat(path.join(directory, entry)).then(() => entry).catch(() => undefined),
  ))
  return generated.filter(Boolean)
}

const previous = {
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_AGENT_TYPE: process.env.CLAXEDO_AGENT_TYPE,
  CURSOR_DATA_DIR: process.env.CURSOR_DATA_DIR,
  OPENCODE_URL: process.env.OPENCODE_URL,
}

afterEach(async () => {
  shutdownEmbeddedWorkspaceRuntimes()
  if (previous.CLAXEDO_DATA_DIR === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previous.CLAXEDO_DATA_DIR
  if (previous.CLAXEDO_AGENT_TYPE === undefined) delete process.env.CLAXEDO_AGENT_TYPE
  else process.env.CLAXEDO_AGENT_TYPE = previous.CLAXEDO_AGENT_TYPE
  if (previous.CURSOR_DATA_DIR === undefined) delete process.env.CURSOR_DATA_DIR
  else process.env.CURSOR_DATA_DIR = previous.CURSOR_DATA_DIR
  if (previous.OPENCODE_URL === undefined) delete process.env.OPENCODE_URL
  else process.env.OPENCODE_URL = previous.OPENCODE_URL
})

describe("embedded workspace runtime", () => {
  test("applies signed workspace Agent Extension records to an active local host", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-embedded-ext-"))
    const project = path.join(root, "project")
    const extension = path.join(project, "extensions", "review")
    await fs.mkdir(extension, { recursive: true })
    await fs.writeFile(path.join(extension, "SKILL.md"), "---\nname: review\n---\n\n# Review\n")

    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    process.env.CLAXEDO_AGENT_TYPE = "opencode"
    process.env.OPENCODE_URL = "http://opencode.test"

    const workspace: Workspace = {
      id: "ws_embedded_extensions",
      directory: project,
      kind: "local",
      created_at: 1,
      updated_at: 1,
    }
    await ensureEmbeddedWorkspaceRuntime(workspace, { config: "skip" })

    await syncEmbeddedWorkspaceRuntimeAgentExtensions(workspace.id, [{
      desired: {
        id: "review",
        package_name: "review",
        source: {
          type: "project",
          package_path: "extensions/review",
        },
        scope: "workspace",
        enabled: true,
        targets: ["cursor"],
        installed_at: 10,
        updated_at: 10,
      },
    }])

    // The generated skill still lands in the workspace — that is the product.
    await expect(fs.readFile(path.join(project, ".cursor", "skills", "review", "SKILL.md"), "utf8"))
      .resolves.toContain("# Review")
    // Only the ownership ledger moves out, to the host data dir keyed by id.
    await expect(fs.readFile(
      path.join(root, "data", "agent-extensions", "workspaces", workspace.id, "materialized.json"),
      "utf8",
    ).then(JSON.parse))
      .resolves.toMatchObject({
        packages: {
          review: {
            status: "applied",
            components: [{
              runner: "cursor",
              type: "skill",
              status: "applied",
            }],
          },
        },
      })

    shutdownEmbeddedWorkspaceRuntimes()
    await fs.rm(root, { recursive: true, force: true })
  })

  // ── Characterization (Unit 1): cache-per-workspace-id, config mode,
  //    configure-affects-creation, shutdown clears the cache. ──────────────────
  test("caches one runtime per workspace id and recreates when the directory changes", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-cache-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    process.env.CLAXEDO_AGENT_TYPE = "opencode"
    process.env.OPENCODE_URL = "http://opencode.test"

    try {
      const ws = workspace("ws_cache", project)
      const first = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      const second = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      // Same workspace id + same directory → the cached runtime is reused.
      expect(second).toBe(first)

      const movedProject = path.join(root, "project-2")
      await fs.mkdir(movedProject, { recursive: true })
      const moved = await ensureEmbeddedWorkspaceRuntime(workspace("ws_cache", movedProject), { config: "skip" })
      // Same id but a different directory → the old runtime is disposed and a
      // fresh one is created.
      expect(moved).not.toBe(first)
    } finally {
      shutdownEmbeddedWorkspaceRuntimes()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("config mode 'skip' does not apply runtime config; 'sync' does", async () => {
    const skip = await makeWorkspaceRoot("claxedo-embedded-skip-")
    const sync = await makeWorkspaceRoot("claxedo-embedded-sync-")
    process.env.CLAXEDO_DATA_DIR = path.join(skip.root, "data")
    process.env.CLAXEDO_AGENT_TYPE = "opencode"
    process.env.OPENCODE_URL = "http://opencode.test"

    try {
      await ensureEmbeddedWorkspaceRuntime(workspace("ws_skip", skip.project), { config: "skip" })
      // "skip" applies nothing at all.
      expect(await appliedStateExists("ws_skip")).toBe(false)

      await ensureEmbeddedWorkspaceRuntime(workspace("ws_sync", sync.project), { config: "sync" })
      // "sync" (the default) applies runtime config, recording replay state
      // under the host data dir keyed by workspace id.
      expect(await appliedStateExists("ws_sync")).toBe(true)

      // ...and neither mode leaves generated state in the user's checkout.
      expect(await workspaceIsClean(skip.project)).toEqual([])
      expect(await workspaceIsClean(sync.project)).toEqual([])
    } finally {
      shutdownEmbeddedWorkspaceRuntimes()
      await fs.rm(skip.root, { recursive: true, force: true })
      await fs.rm(sync.root, { recursive: true, force: true })
    }
  })

  test("configureEmbeddedWorkspaceRuntime does not retroactively recreate a cached runtime", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-configure-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    process.env.CLAXEDO_AGENT_TYPE = "opencode"
    process.env.OPENCODE_URL = "http://opencode.test"

    try {
      const ws = workspace("ws_configure", project)
      const first = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })

      // Reconfiguring the module-level opencode target only affects NEW
      // creations; an already-cached runtime is not recreated.
      configureEmbeddedWorkspaceRuntime({ opencodeRequest: async () => new Response(null, { status: 404 }) })
      const afterConfigure = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      expect(afterConfigure).toBe(first)

      // A brand-new workspace created after reconfiguring gets its own runtime.
      const freshProject = project + "-new"
      await fs.mkdir(freshProject, { recursive: true })
      const fresh = await ensureEmbeddedWorkspaceRuntime(workspace("ws_configure_new", freshProject), {
        config: "skip",
      })
      expect(fresh).not.toBe(first)
    } finally {
      // Restore the default target so we do not leak the reconfigured URL into
      // other tests in this file.
      configureEmbeddedWorkspaceRuntime({ opencodeRequest: async () => new Response(null, { status: 404 }) })
      shutdownEmbeddedWorkspaceRuntimes()
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(project + "-new", { recursive: true, force: true }).catch(() => {})
    }
  })

  test("shutdownEmbeddedWorkspaceRuntimes clears the cache", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-shutdown-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    process.env.CLAXEDO_AGENT_TYPE = "opencode"
    process.env.OPENCODE_URL = "http://opencode.test"

    try {
      const ws = workspace("ws_shutdown", project)
      const first = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })

      shutdownEmbeddedWorkspaceRuntimes()

      // After shutdown the cache is empty, so the next ensure builds a fresh
      // runtime rather than returning the disposed one.
      const rebuilt = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      expect(rebuilt).not.toBe(first)
    } finally {
      shutdownEmbeddedWorkspaceRuntimes()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("mounts the production transcript resolver for each embedded workspace", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-transcripts-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")

    try {
      const runtime = await ensureEmbeddedWorkspaceRuntime(workspace("ws_transcripts", project), { config: "skip" })
      const response = await runtime.app.request(
        "http://localhost/api/wr/subagent-transcripts/not-a-handle?parentSessionId=parent",
      )

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ state: "unavailable", reason: "invalid-handle" })
      const unauthorized = await runtime.app.request(
        "http://localhost/api/wr/runtime-events?parentSessionId=missing-parent",
      )
      expect(unauthorized.status).toBe(403)
    } finally {
      shutdownEmbeddedWorkspaceRuntimes()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("uses Cursor's canonical project transcript root instead of the workspace checkout", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-cursor-root-")
    process.env.CURSOR_DATA_DIR = path.join(root, "cursor-data")

    try {
      expect(cursorTranscriptRoot(project)).toBe(path.join(
        root,
        "cursor-data",
        "projects",
        project.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, ""),
        "agent-transcripts",
      ))
      expect(cursorTranscriptRoot(project)).not.toContain(path.join(project, path.sep))
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("releaseEmbeddedWorkspaceRuntime disposes one cached workspace runtime", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-release-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")

    try {
      const ws = workspace("ws_release", project)
      const first = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      releaseEmbeddedWorkspaceRuntime(ws.id)
      expect(await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })).not.toBe(first)
    } finally {
      shutdownEmbeddedWorkspaceRuntimes()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("passes the configured Pi model backend into embedded workspace sessions", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-pi-backend-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")

    try {
      const resolved: unknown[] = []
      configureEmbeddedWorkspaceRuntime({
        opencodeRequest: async () => new Response(null, { status: 404 }),
        piModelBackend: (input) => {
          resolved.push(input)
          return undefined
        },
      })
      const runtime = await ensureEmbeddedWorkspaceRuntime(workspace("ws_pi_backend", project), { config: "skip" })
      const query = `directory=${encodeURIComponent(project)}&runner=pi`
      const created = await runtime.app.request(`http://localhost/session?${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Pi backend" }),
      })
      const session = await created.json() as { id: string }
      const configured = await runtime.app.request(`http://localhost/session/${session.id}/config?${query}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: { providerID: "openai-codex", modelID: "gpt-5.5" } }),
      })
      const sent = await runtime.app.request(`http://localhost/session/${session.id}/message?${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [{ type: "text", text: "hello" }],
          model: { providerID: "openai-codex", modelID: "gpt-5.5" },
        }),
      })

      expect(created.status).toBe(201)
      expect(configured.status).toBe(200)
      expect(sent.status).toBe(200)
      expect(resolved).toEqual([{
        sessionId: session.id,
        model: { providerID: "openai-codex", modelID: "gpt-5.5" },
      }])
    } finally {
      configureEmbeddedWorkspaceRuntime({ opencodeRequest: async () => new Response(null, { status: 404 }) })
      shutdownEmbeddedWorkspaceRuntimes()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("serves no WorkGraph route when the host contributes no capability", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-no-workgraph-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    process.env.CLAXEDO_AGENT_TYPE = "pi"

    try {
      configureEmbeddedWorkspaceRuntime({
        opencodeRequest: async () => new Response(null, { status: 404 }),
        // No host contributions at all — the shape a desktop-local build has.
        routeContributions: [],
      })
      const ws = workspace("ws_no_workgraph", project)
      const runtime = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      const query = `directory=${encodeURIComponent(project)}&runner=pi`

      for (const path of [
        "/api/workgraph/run-binding",
        "/api/workgraph/run-tools",
        "/api/workgraph/connection-binding",
        "/api/workgraph/tools",
      ]) {
        const response = await runtime.app.request(`http://localhost${path}?${query}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
        expect(response.status, path).toBe(404)
      }
    } finally {
      configureEmbeddedWorkspaceRuntime({ opencodeRequest: async () => new Response(null, { status: 404 }) })
      shutdownEmbeddedWorkspaceRuntimes()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  // ── Regression: a harness session's async auto-title (e.g. an ACP
  //    harness's post-turn `maybeEmitTitle`, or opencode's own LLM-driven
  //    rename) is published ONLY as an SSE event on this runtime's own
  //    `/global/event` stream (`RuntimeEventHub.publishGlobal`), never an
  //    HTTP `PATCH /session/:id`. Before this fix nothing tapped that
  //    per-workspace stream, so `services.projectionStore` never learned the
  //    title and it reverted to "Untitled" after a restart. This proves the
  //    tap itself: a `session.updated` event on `/global/event` reaches the
  //    `onSessionMetaEvent` callback claxedo-server wires to
  //    `projectLocalSessionMetaFromEvent` (see `session-meta-bridge.test.ts`
  //    for that write path proven against the real SQLite projection store).
  test("starts the metadata tap on the first engine mutation and propagates SSE-only title events", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-title-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    process.env.CLAXEDO_AGENT_TYPE = "opencode"
    process.env.OPENCODE_URL = "http://opencode.test"

    try {
      const events: OpencodeEvent[] = []
      let resolveSeen: (() => void) | undefined
      const seen = new Promise<void>((resolve) => {
        resolveSeen = resolve
      })

      // Stands in for the real opencode process: claxedo-server rides this
      // injected transport in embedded mode (see `configureEmbeddedWorkspaceRuntime`
      // in `server.ts`), so the workspace runtime's `/global/event` route
      // proxies straight through it — exactly as it would a real opencode
      // subprocess's own SSE stream.
      const fakeOpencodeRequest: OpenCodeRequestFn = async (req) => {
        const url = new URL(req.url)
        if (url.pathname !== "/global/event") return Response.json({ id: "s_mutation", directory: project })
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const envelope = {
              directory: project,
              payload: {
                id: "session.updated:s_auto_title",
                type: "session.updated",
                properties: {
                  sessionID: "s_auto_title",
                  info: { id: "s_auto_title", title: "Auto-generated title", directory: project },
                },
              },
            }
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(envelope)}\n\n`))
            // Deliberately never closed: closing would trigger the SSE
            // client's reconnect-with-backoff loop, which would otherwise
            // keep firing after this test's assertions complete.
          },
        })
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
      }

      configureEmbeddedWorkspaceRuntime({
        opencodeRequest: fakeOpencodeRequest,
        onSessionMetaEvent: (event) => {
          events.push(event)
          resolveSeen?.()
        },
      })

      const runtime = await ensureEmbeddedWorkspaceRuntime(workspace("ws_title", project), { config: "skip" })
      await runtime.app.request(`http://localhost/session?directory=${encodeURIComponent(project)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      await seen

      expect(events).toHaveLength(1)
      const [event] = events
      expect(event?.payload.type).toBe("session.updated")
      const info = event?.payload.properties?.info as { id?: string; title?: string } | undefined
      expect(info?.id).toBe("s_auto_title")
      expect(info?.title).toBe("Auto-generated title")
    } finally {
      // Reset the module singleton so later tests in this file don't inherit
      // this test's callback or fake transport.
      configureEmbeddedWorkspaceRuntime({ opencodeRequest: async () => new Response(null, { status: 404 }) })
      shutdownEmbeddedWorkspaceRuntimes()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("reconciles persisted runtime titles when rebuilding a workspace after restart", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-title-reconcile-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    process.env.CLAXEDO_AGENT_TYPE = "opencode"
    process.env.OPENCODE_URL = "http://opencode.test"

    try {
      const snapshots: unknown[][] = []
      configureEmbeddedWorkspaceRuntime({
        opencodeRequest: async (req: Request) => {
          const url = new URL(req.url)
          if (url.pathname === "/session") {
            return Response.json([{
              id: "s_existing_title",
              title: "Title generated before restart",
              directory: project,
              time: { created: 1, updated: 2 },
            }])
          }
          if (url.pathname === "/global/event") {
            return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
              headers: { "content-type": "text/event-stream" },
            })
          }
          return new Response(null, { status: 404 })
        },
        onSessionMetaSnapshot: (_workspace: Workspace, sessions: unknown[]) => {
          snapshots.push(sessions)
        },
      } as never)

      await ensureEmbeddedWorkspaceRuntime(workspace("ws_title_reconcile", project), { config: "skip" })

      expect(snapshots).toEqual([[
        expect.objectContaining({
          id: "s_existing_title",
          title: "Title generated before restart",
        }),
      ]])
    } finally {
      configureEmbeddedWorkspaceRuntime({ opencodeRequest: async () => new Response(null, { status: 404 }) })
      shutdownEmbeddedWorkspaceRuntimes()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  // ── The session-metadata snapshot is reconciled on demand, not per request ──
  //
  // `reconcileSessionMetadata` used to re-run a full `GET /session` plus one
  // `sync_session_meta` per session on EVERY proxied request: measured
  // 0.133 ms per session per request, 3.45 ms of a 5.2 ms read at 20 sessions.
  // These tests hold the two halves of the replacement together — that reads
  // stop re-snapshotting, and that everything which can change the runtime's
  // session list still forces one.

  // A harness for the snapshot: counts snapshots and lets a test change what
  // the runtime's session list answers, so "identical data" is a comparison
  // against the runtime rather than against a remembered literal.
  function snapshotHarness(project: string) {
    const snapshots: unknown[][] = []
    let sessions: Array<Record<string, unknown>> = [
      { id: "s_one", title: "One", directory: project, time: { created: 1, updated: 2 } },
    ]
    configureEmbeddedWorkspaceRuntime({
      opencodeRequest: async (req: Request) => {
        const url = new URL(req.url)
        if (url.pathname === "/global/event") {
          return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            headers: { "content-type": "text/event-stream" },
          })
        }
        // An engine that answers mutations, so a create/rename really changes
        // what the runtime lists rather than only what this fake returns.
        if (req.method !== "GET" && req.method !== "HEAD") {
          return Response.json({ id: "s_mutated", title: "Mutated", directory: project })
        }
        if (url.pathname === "/session") return Response.json(sessions)
        return new Response(null, { status: 404 })
      },
      onSessionMetaSnapshot: (_workspace: Workspace, listed: unknown[]) => {
        snapshots.push(listed)
      },
    } as never)
    return {
      snapshots,
      /** Change what the runtime answers, the way a real mutation would. */
      setSessions(next: Array<Record<string, unknown>>) {
        sessions = next
      },
    }
  }

  test("a repeated read reconciles the session snapshot once, and it matches the runtime", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-snapshot-read-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    process.env.CLAXEDO_AGENT_TYPE = "opencode"
    process.env.OPENCODE_URL = "http://opencode.test"

    try {
      const harness = snapshotHarness(project)
      const ws = workspace("ws_snapshot_read", project)

      await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      for (let i = 0; i < 5; i++) await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })

      // One snapshot for the whole sequence, not one per request.
      expect(harness.snapshots).toHaveLength(1)
      // And the cached path is not serving a different answer from the
      // uncached one: the single snapshot equals what the runtime lists now.
      const runtime = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      const listed = await (await runtime.app
        .request(`http://localhost/session?directory=${encodeURIComponent(project)}`)).json()
      expect(harness.snapshots[0]).toEqual(listed)
    } finally {
      configureEmbeddedWorkspaceRuntime({ opencodeRequest: async () => new Response(null, { status: 404 }) })
      shutdownEmbeddedWorkspaceRuntimes()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  // The invalidation contract, stated as data so every source is covered by
  // the same assertion and a new source cannot be added without a case.
  const inventoryChanges: Array<{ name: string; method: string; path: string; visibleInList: boolean }> = [
    { name: "a session is created", method: "POST", path: "/session", visibleInList: true },
    // A rename reaches the runtime store through the engine, which this fake
    // does not model, so the generic list content is unchanged here. It is
    // still an invalidation source: the projection's title comes from the
    // snapshot, so a read after it must not serve the pre-rename answer.
    { name: "a session is renamed", method: "PATCH", path: "/session/s_one", visibleInList: false },
    { name: "a session is deleted", method: "DELETE", path: "/session/s_one", visibleInList: true },
    // The one READ that can change the answer: an explicit harness refresh
    // imports sessions created outside Claxedo into the runtime store.
    { name: "an explicit harness refresh lists", method: "GET", path: "/session?harness=opencode", visibleInList: true },
  ]

  for (const change of inventoryChanges) {
    test(`re-reconciles after ${change.name}`, async () => {
      const { root, project } = await makeWorkspaceRoot("claxedo-embedded-snapshot-invalidate-")
      process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
      process.env.CLAXEDO_AGENT_TYPE = "opencode"
      process.env.OPENCODE_URL = "http://opencode.test"

      try {
        const harness = snapshotHarness(project)
        const ws = workspace("ws_snapshot_invalidate", project)
        await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
        await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
        expect(harness.snapshots).toHaveLength(1)

        // The runtime's answer changes, and the request that changed it is
        // dispatched through the local runtime port — the same entry
        // `sandboxFetch` uses, so this covers the in-process callers too.
        harness.setSessions([
          { id: "s_one", title: "One (renamed)", directory: project, time: { created: 1, updated: 9 } },
          { id: "s_two", title: "Two", directory: project, time: { created: 3, updated: 4 } },
        ])
        const separator = change.path.includes("?") ? "&" : "?"
        await localWorkspaceRuntime().fetch(
          ws,
          new Request(`http://embedded-workspace-runtime.local${change.path}${separator}directory=${encodeURIComponent(project)}`, {
            method: change.method,
            ...(change.method === "GET" ? {} : { headers: { "content-type": "application/json" }, body: "{}" }),
          }),
        )

        // The next read reconciles again, and what it recorded is what the
        // runtime answers NOW — the cached path and the uncached path agree.
        const runtime = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
        expect(harness.snapshots).toHaveLength(2)
        const listed = await (await runtime.app
          .request(`http://localhost/session?directory=${encodeURIComponent(project)}`)).json()
        expect(harness.snapshots[1]).toEqual(listed)
        // ...and where the change is observable in the list, the second
        // snapshot really carries it — this is not two snapshots of the same
        // data dressed up as a reconcile.
        if (change.visibleInList) expect(harness.snapshots[1]).not.toEqual(harness.snapshots[0])

        // ...and then goes quiet again until something else changes.
        await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
        expect(harness.snapshots).toHaveLength(2)
      } finally {
        configureEmbeddedWorkspaceRuntime({ opencodeRequest: async () => new Response(null, { status: 404 }) })
        shutdownEmbeddedWorkspaceRuntimes()
        await fs.rm(root, { recursive: true, force: true })
      }
    })
  }

  test("a plain read does NOT invalidate — this is the assertion the cache exists for", async () => {
    // The negative half of the contract above. Without it, a change that
    // invalidated on every request would still pass every test in this block.
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-snapshot-negative-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    process.env.CLAXEDO_AGENT_TYPE = "opencode"
    process.env.OPENCODE_URL = "http://opencode.test"

    try {
      const harness = snapshotHarness(project)
      const ws = workspace("ws_snapshot_negative", project)
      await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })

      for (let i = 0; i < 3; i++) {
        await localWorkspaceRuntime().fetch(
          ws,
          new Request(`http://embedded-workspace-runtime.local/session?directory=${encodeURIComponent(project)}`),
        )
        await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      }

      expect(harness.snapshots).toHaveLength(1)
    } finally {
      configureEmbeddedWorkspaceRuntime({ opencodeRequest: async () => new Response(null, { status: 404 }) })
      shutdownEmbeddedWorkspaceRuntimes()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("a failed snapshot is retried by the next request rather than cached", async () => {
    // The snapshot is a repair mechanism; recording a FAILED one as reconciled
    // would disable the repair until the next mutation. Only a snapshot that
    // completed is recorded, so the next request tries again.
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-snapshot-retry-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    process.env.CLAXEDO_AGENT_TYPE = "opencode"
    process.env.OPENCODE_URL = "http://opencode.test"

    try {
      const attempts: unknown[][] = []
      let failing = true
      configureEmbeddedWorkspaceRuntime({
        opencodeRequest: async (req: Request) => {
          const url = new URL(req.url)
          if (url.pathname === "/global/event") {
            return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
              headers: { "content-type": "text/event-stream" },
            })
          }
          return new Response(null, { status: 404 })
        },
        onSessionMetaSnapshot: (_workspace: Workspace, listed: unknown[]) => {
          attempts.push(listed)
          if (failing) throw new Error("projection store unavailable")
        },
      } as never)

      const ws = workspace("ws_snapshot_retry", project)
      await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      expect(attempts).toHaveLength(1)

      // The failure is not cached: the next read retries it...
      failing = false
      await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      expect(attempts).toHaveLength(2)

      // ...and once one succeeds, reads go quiet again.
      await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      expect(attempts).toHaveLength(2)
    } finally {
      configureEmbeddedWorkspaceRuntime({ opencodeRequest: async () => new Response(null, { status: 404 }) })
      shutdownEmbeddedWorkspaceRuntimes()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

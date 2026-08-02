import { afterEach, describe, expect, test } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import {
  configureEmbeddedWorkspaceRuntime,
  ensureEmbeddedWorkspaceRuntime,
  releaseEmbeddedWorkspaceRuntime,
  shutdownEmbeddedWorkspaceRuntimes,
  syncEmbeddedWorkspaceRuntimeAgentExtensions,
} from "./embedded-workspace-runtime"
import type { OpencodeEvent } from "../../opencode/events"
import type { OpenCodeRequestFn } from "../../opencode/engine"
import type { Workspace } from "../../workspace/store"

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
  OPENCODE_URL: process.env.OPENCODE_URL,
}

afterEach(async () => {
  shutdownEmbeddedWorkspaceRuntimes()
  if (previous.CLAXEDO_DATA_DIR === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previous.CLAXEDO_DATA_DIR
  if (previous.CLAXEDO_AGENT_TYPE === undefined) delete process.env.CLAXEDO_AGENT_TYPE
  else process.env.CLAXEDO_AGENT_TYPE = previous.CLAXEDO_AGENT_TYPE
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

  test("passes the trusted WorkGraph Run broker into new embedded runtimes", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-run-broker-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    process.env.CLAXEDO_AGENT_TYPE = "pi"

    try {
      configureEmbeddedWorkspaceRuntime({
        opencodeRequest: async () => new Response(null, { status: 404 }),
        workgraphRunBroker: async () => {
          throw new Error("not invoked while binding")
        },
      })
      const ws = workspace("ws_run_broker", project)
      const runtime = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      const query = `directory=${encodeURIComponent(project)}&runner=pi`
      const created = await runtime.app.request(`http://localhost/session?${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Managed Run" }),
      })
      expect(created.status, await created.clone().text()).toBe(201)
      const session = await created.json() as { id: string }
      const bound = await runtime.app.request(`http://localhost/api/workgraph/run-binding?${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          identity: {
            runId: "run-1",
            sessionId: session.id,
            workspaceId: ws.id,
            generation: 1,
          },
          harness: "pi",
          brokerUrl: "http://127.0.0.1",
        }),
      })
      expect(bound.status, await bound.clone().text()).toBe(200)
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
  test("propagates a harness's SSE-only session.updated title event to onSessionMetaEvent", async () => {
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
        if (url.pathname !== "/global/event") return new Response(null, { status: 404 })
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

      await ensureEmbeddedWorkspaceRuntime(workspace("ws_title", project), { config: "skip" })
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
})

import { afterEach, describe, expect, test } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import {
  configureEmbeddedWorkspaceRuntime,
  cursorTranscriptRoot,
  embeddedWorkspaceRuntimeSessionAuthority,
  ensureEmbeddedWorkspaceRuntime,
  releaseEmbeddedWorkspaceRuntime,
  shutdownEmbeddedWorkspaceRuntimes,
  syncEmbeddedWorkspaceRuntimeAgentExtensions,
} from "./embedded-workspace-runtime"
import type { OpencodeEvent } from "../../opencode/events"
import { disposeAgentConfig } from "@claxedo/server-core/agent-config/index"
import type { OpenCodeRequestFn } from "@claxedo/server-core/opencode/engine"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { closeAuthorityDatabases } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import { managedWorkspaceSessionAccessPolicy } from "@claxedo/workspace-runtime"
import { EMBEDDED_RELAY_HOST_AUTH_HEADER } from "@claxedo/workspace-runtime/exposure"

/**
 * Delete workspace roots AFTER releasing the module-scoped sqlite handles:
 * the embedded runtime's data dir holds claxedo.db and authority.db, and
 * Windows refuses to unlink them while a handle is open (EBUSY/EPERM).
 * Both closes are registry resets, so later tests lazily reopen.
 */
async function removeWorkspaceRoot(...roots: string[]) {
  ClaxedoDB.close()
  closeAuthorityDatabases()
  for (const root of roots) await fs.rm(root, { recursive: true, force: true })
}

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

function shutdownTestRuntimes() {
  shutdownEmbeddedWorkspaceRuntimes()
  // Direct embedded-runtime tests own the default agent-config authority that
  // runtime configuration opens lazily; no LocalServer exists to dispose it.
  disposeAgentConfig()
  // Agent-extension persistence also opens the shared Claxedo database. These
  // direct tests own that singleton, so release it before Windows removes the
  // temporary data directory.
  ClaxedoDB.close()
  closeAuthorityDatabases()
}

afterEach(async () => {
  shutdownTestRuntimes()
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
  test("reports the composition its runtimes are actually mounted with", async () => {
    // A host that shares these runtimes must DECLARE this to the control
    // plane, which mints every client's event-stream scope from the
    // declaration and infers nothing. Read from the configured policy rather
    // than restated, so the declaration cannot drift from what is mounted:
    // an unsigned desktop leaves the unbound local policy in place, a signed
    // host injects an authority and becomes managed-private.
    expect(embeddedWorkspaceRuntimeSessionAuthority()).toBe("local")

    configureEmbeddedWorkspaceRuntime({
      opencodeRequest: async () => new Response(null, { status: 404 }),
      sessionAccessPolicy: managedWorkspaceSessionAccessPolicy({
        authority: {
          authorizeSessionRead: () => true,
          authorizeSessionWrite: () => true,
          authorizeSessionStream: () => ({ allowed: true as const, lease: "lease", expiresAt: Date.now() + 60_000 }),
          registerSession: () => true,
          acquireTurn: (input) => ({
            allowed: true,
            turnId: input.turnId,
            leaseId: "turn_lease_1",
            fencingToken: 1,
            acquiredAt: Date.now(),
            expiresAt: Date.now() + 15_000,
          }),
          renewTurn: (input) => ({
            allowed: true,
            turnId: input.turnId,
            leaseId: input.leaseId,
            fencingToken: input.fencingToken + 1,
            acquiredAt: Date.now(),
            expiresAt: Date.now() + 15_000,
          }),
          releaseTurn: () => ({ released: true }),
        },
      }),
    })
    try {
      expect(embeddedWorkspaceRuntimeSessionAuthority()).toBe("managed-private")
    } finally {
      configureEmbeddedWorkspaceRuntime({ opencodeRequest: async () => new Response(null, { status: 404 }) })
    }
    expect(embeddedWorkspaceRuntimeSessionAuthority()).toBe("local")
  })

  test("uses the signed composition's managed-private session authority", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-private-session-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    const authorityCalls: string[] = []
    const sessionAccessPolicy = managedWorkspaceSessionAccessPolicy({
      requireActor: true,
      // The authority is ONE bundle, so a composition cannot answer reads and
      // writes while leaving the stream capability unanswered — which is what
      // made every managed terminal 503 `terminal_capability_authority_unavailable`.
      authority: {
        authorizeSessionRead: (input) => {
          authorityCalls.push(`${input.actor.actorId}:read:${input.sessionId}:${input.credential}`)
          return input.actor.actorId === "actor_alice"
        },
        authorizeSessionWrite: (input) => {
          authorityCalls.push(`${input.actor.actorId}:write:${input.sessionId}:${input.credential}`)
          return input.actor.actorId === "actor_alice"
        },
        authorizeSessionStream: (input) => {
          authorityCalls.push(`${input.actor.actorId}:stream:${input.sessionId}:${input.credential}`)
          return input.actor.actorId === "actor_alice"
            ? { allowed: true as const, lease: `lease_${input.sessionId}`, expiresAt: Date.now() + 60_000 }
            : { allowed: false as const, status: 403 as const, code: "session_private", message: "Not a participant" }
        },
        registerSession: () => true,
        acquireTurn: (input) => ({
          allowed: true,
          turnId: input.turnId,
          leaseId: "turn_lease_1",
          fencingToken: 1,
          acquiredAt: Date.now(),
          expiresAt: Date.now() + 15_000,
        }),
        renewTurn: (input) => ({
          allowed: true,
          turnId: input.turnId,
          leaseId: input.leaseId,
          fencingToken: input.fencingToken + 1,
          acquiredAt: Date.now(),
          expiresAt: Date.now() + 15_000,
        }),
        releaseTurn: () => ({ released: true }),
      },
    })
    configureEmbeddedWorkspaceRuntime({
      opencodeRequest: async () => Response.json({ id: "ses_private", directory: project, title: "Private" }),
      sessionAccessPolicy,
    })

    try {
      const runtime = await ensureEmbeddedWorkspaceRuntime(workspace("ws_private", project), { config: "skip" })
      const embeddedClaims = (actorId: string, actorName: string) => JSON.stringify({
        principal_kind: "user",
        actor_id: actorId,
        actor_kind: "human",
        actor_public_id: actorId.replace("actor_", "usr_"),
        actor_name: actorName,
        workspace_id: "ws_private",
        org_id: "org_1",
        role: "editor",
      })
      const denied = await runtime.app.request("http://runtime.test/session/ses_private", {
        headers: {
          authorization: "Bearer bob-proof",
          [EMBEDDED_RELAY_HOST_AUTH_HEADER]: embeddedClaims("actor_bob", "Bob"),
        },
      })
      expect(denied.status).toBe(403)
      await expect(denied.json()).resolves.toMatchObject({ error: { code: "session_private" } })

      const allowed = await runtime.app.request("http://runtime.test/session/ses_private", {
        headers: {
          authorization: "Bearer alice-proof",
          [EMBEDDED_RELAY_HOST_AUTH_HEADER]: embeddedClaims("actor_alice", "Alice"),
        },
      })
      expect(allowed.status).toBe(200)
      expect(authorityCalls).toEqual([
        "actor_bob:read:ses_private:Bearer bob-proof",
        "actor_alice:read:ses_private:Bearer alice-proof",
      ])
    } finally {
      configureEmbeddedWorkspaceRuntime({ opencodeRequest: async () => new Response(null, { status: 404 }) })
      shutdownTestRuntimes()
      await removeWorkspaceRoot(root)
    }
  })

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

    shutdownTestRuntimes()
    await removeWorkspaceRoot(root)
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
      shutdownTestRuntimes()
      await removeWorkspaceRoot(root)
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
      shutdownTestRuntimes()
      await removeWorkspaceRoot(skip.root, sync.root)
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
      shutdownTestRuntimes()
      await removeWorkspaceRoot(root)
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
      shutdownTestRuntimes()
      await removeWorkspaceRoot(root)
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
      shutdownTestRuntimes()
      await removeWorkspaceRoot(root)
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
      await removeWorkspaceRoot(root)
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
      shutdownTestRuntimes()
      await removeWorkspaceRoot(root)
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
      shutdownTestRuntimes()
      await removeWorkspaceRoot(root)
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
      const requests: string[] = []
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
        requests.push(`${req.method} ${url.pathname}`)
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
      expect(requests).not.toContain("GET /global/event")
      await runtime.app.request(`http://localhost/session?directory=${encodeURIComponent(project)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      await seen

      expect(requests.indexOf("GET /global/event")).toBeLessThan(requests.indexOf("POST /session"))

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
      shutdownTestRuntimes()
      await removeWorkspaceRoot(root)
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
      shutdownTestRuntimes()
      await removeWorkspaceRoot(root)
    }
  })
})

describe("compat hub -> globalBus bridge", () => {
  // The regression this pins: an ACP harness turn's message/error compat
  // events published on the embedded runtime's hub never reached globalBus,
  // and the central `/global/event` + `/api/wr/events` stream — a LOCAL
  // workspace's only live channel into claxedo-app — carried lifecycle and
  // process frames only. A live turn's reply (and its error card) rendered in
  // an already-open timeline only after a manual refresh.
  test("publishes hub envelopes to globalBus in the engine bridge's wire shape", async () => {
    const { globalBus } = await import("@claxedo/server-core/platform/runtime/lib/bus")
    const { bridgeCompatEventToGlobalBus } = await import("./embedded-workspace-runtime")
    const seen: unknown[] = []
    const unsubscribe = globalBus.subscribe((event) => seen.push(event))
    try {
      bridgeCompatEventToGlobalBus({
        directory: "/repo/main",
        payload: {
          type: "message.part.delta",
          // A part's deltas all carry ONE stable payload id — it must be
          // stripped before the wire so it can never become the SSE frame id.
          id: "message.part.delta:msg_1:part_1",
          properties: { sessionID: "ses_1", messageID: "msg_1", partID: "part_1", field: "text", delta: "API Error: 503" },
        } as { type: string; properties?: unknown },
      })
      bridgeCompatEventToGlobalBus({
        payload: { type: "session.error", properties: { sessionID: "ses_1", error: "auth_unavailable" } },
      })
    } finally {
      unsubscribe()
    }

    expect(seen).toEqual([
      {
        directory: "/repo/main",
        payload: {
          type: "message.part.delta",
          properties: { sessionID: "ses_1", messageID: "msg_1", partID: "part_1", field: "text", delta: "API Error: 503" },
        },
      },
      // Directory defaults to "global" like the engine bridge, never undefined:
      // the central handler keys frames by directory for the app's router.
      {
        directory: "global",
        payload: { type: "session.error", properties: { sessionID: "ses_1", error: "auth_unavailable" } },
      },
    ])
  })
})


/**
 * The seam is only worth anything if the composition root's hook actually
 * reaches the runtime that answers `/provider`. This drives a real embedded
 * runtime and asks it for a non-opencode catalog.
 */
describe("embedded runtime provider catalog", () => {
  test("a workspace-scoped /provider for a non-opencode harness answers the host's catalog", async () => {
    const { root, project } = await makeWorkspaceRoot("embedded-provider-")
    const asked: string[] = []
    configureEmbeddedWorkspaceRuntime({
      opencodeRequest: async () => new Response(null, { status: 404 }),
      providerCatalog: async ({ harnessId }) => {
        asked.push(harnessId)
        return { all: [{ id: "anthropic", name: "Anthropic", models: {} }], default: {}, connected: [] }
      },
    })
    try {
      const runtime = await ensureEmbeddedWorkspaceRuntime(workspace("ws_provider", project), { config: "skip" })
      const res = await runtime.app.request("http://runtime.test/provider?harness=claude-sdk")
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ all: [{ id: "anthropic" }] })
      expect(asked).toEqual(["claude-sdk"])
    } finally {
      await shutdownEmbeddedWorkspaceRuntimes()
      await removeWorkspaceRoot(root)
    }
  })
})

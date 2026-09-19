import { afterAll, beforeAll, afterEach, describe, expect, test } from "vitest"
import { installFakePiRpc } from "../../../../agent-sdk-runtime/src/test-utils/fake-pi-rpc.mjs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import {
  configureEmbeddedWorkspaceRuntime,
  cursorTranscriptRoot,
  embeddedWorkspaceRuntimeSessionAuthority,
  ensureEmbeddedWorkspaceRuntime,
  onEmbeddedWorkspaceRuntime,
  releaseEmbeddedWorkspaceRuntime,
  shutdownEmbeddedWorkspaceRuntimes,
  type MountedEmbeddedWorkspaceRuntime,
} from "./embedded-workspace-runtime"
import { workspaceRuntimeBus } from "@claxedo/workspace-runtime/host"
import { Hono } from "hono"
import { createHostAggregateEventsHandler } from "../../shell/host-events"
import type { WorkspaceEventStreamFrame } from "@claxedo/workspace-runtime"
import { disposeAgentConfig, loadUserConfig, saveUserConfig } from "@claxedo/server-core/agent-config/index"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { localWorkspaceRuntimeSessionAuthority } from "@claxedo/server-core/workspace/local-runtime-port"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { closeAuthorityDatabases } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import { managedWorkspaceSessionAccessPolicy } from "@claxedo/workspace-runtime"
import { EMBEDDED_RELAY_HOST_AUTH_HEADER } from "@claxedo/workspace-runtime/exposure"
import { createAcpConnectionProvider, NO_HARNESS_EFFORT, type ConnectionProvider } from "@claxedo/agent-sdk-runtime"
import { createOpenCodeServerConnectionProvider } from "@claxedo/opencode-server-adapter"

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

// Runtime configuration must not recreate its retired state directory in a user's checkout.
async function workspaceIsClean(directory: string) {
  const generated = await Promise.all([".workspace-runtime"].map((entry) =>
    fs.stat(path.join(directory, entry)).then(() => entry).catch(() => undefined),
  ))
  return generated.filter(Boolean)
}

const previous = {
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_AGENT_TYPE: process.env.CLAXEDO_AGENT_TYPE,
  CURSOR_DATA_DIR: process.env.CURSOR_DATA_DIR,
}

async function shutdownTestRuntimes() {
  await shutdownEmbeddedWorkspaceRuntimes()
  // Direct embedded-runtime tests own the default agent-config authority that
  // runtime configuration opens lazily; no LocalServer exists to dispose it.
  disposeAgentConfig()
  // Direct tests own the shared Claxedo database singleton, so release it
  // before Windows removes the temporary data directory.
  ClaxedoDB.close()
  closeAuthorityDatabases()
}

afterEach(async () => {
  await shutdownTestRuntimes()
  if (previous.CLAXEDO_DATA_DIR === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previous.CLAXEDO_DATA_DIR
  if (previous.CLAXEDO_AGENT_TYPE === undefined) delete process.env.CLAXEDO_AGENT_TYPE
  else process.env.CLAXEDO_AGENT_TYPE = previous.CLAXEDO_AGENT_TYPE
  if (previous.CURSOR_DATA_DIR === undefined) delete process.env.CURSOR_DATA_DIR
  else process.env.CURSOR_DATA_DIR = previous.CURSOR_DATA_DIR
})

describe("embedded workspace runtime", () => {
  test.each(["directory", "release", "shutdown", "shutdown-waiter"] as const)("%s retirement drains the old producer before the same store root is reopened", async (mode) => {
    const { root, project } = await makeWorkspaceRoot("embedded-runtime-drain-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    const ws = workspace("ws_drain", project)
    const moved = path.join(root, "moved")
    await fs.mkdir(moved)
    const deferred = () => {
      let resolve!: () => void
      const promise = new Promise<void>((done) => { resolve = done })
      return { promise, resolve }
    }
    const started = deferred()
    const stopped = deferred()
    const tail = deferred()
    const producerDone = deferred()
    const capabilities = {
      abort: false, reconnect: false, replay: true, permissions: false, questions: false,
      todos: false, commands: false, fork: false, revert: false, unrevert: false,
      configOptions: false, subagents: false,
    }
    const provider: ConnectionProvider<Record<string, never>> = {
      providerKey: "held-producer",
      validateConfig: () => ({}),
      project: () => ({ label: "Held producer", readiness: "ready", capabilities }),
      resolve: () => ({ config: {} }),
      createAdapter: () => {
        let ownsProducer = false
        return {
          sessionConfigOwner: "runtime",
          instructionChannel: "none" as const,
          async createSession(_directory, _title, id) { return { id: id!, agentSessionId: "upstream-held" } },
          async getSession() { return null },
          async getMessages() { return [] },
          async updateSession() { return null },
          async deleteSession() {},
          async getSessionConfig() { throw new Error("runtime-owned config") },
          async updateSessionConfig() { throw new Error("runtime-owned config") },
          readHarnessCapabilities: () => ({
            ...capabilities,
            goals: false,
            harness: "held",
            effortLevels: NO_HARNESS_EFFORT,
            instructionChannel: "none" as const,
          }),
          async *executeTurn(binding) {
            ownsProducer = true
            started.resolve()
            try {
              await stopped.promise
              await tail.promise
              yield { type: "text-delta", delta: "final producer text" }
              yield { type: "finish", sessionId: binding.sessionId }
            } finally { producerDone.resolve() }
          },
          dispose() {
            if (!ownsProducer) return undefined
            stopped.resolve()
            return producerDone.promise
          },
        }
      },
    }
    configureEmbeddedWorkspaceRuntime({ connectionProviders: [provider] })
    let prompt: Promise<Response> | undefined
    try {
      const first = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      await first.host.apply({ version: 4, mcp: {}, auth: {}, connections: [{
        connectionId: "held", providerKey: "held-producer", configRevision: 1, enabled: true, config: {},
      }], defaultHarness: { kind: "connection", connectionId: "held" } })
      const request = (pathname: string, body: unknown) => Promise.resolve(first.app.request(
        `http://runtime.test${pathname}?directory=${encodeURIComponent(project)}&connectionId=held`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      ))
      expect((await request("/session", { id: "held-session", title: "Held" })).status).toBe(201)
      prompt = request("/session/held-session/message", { parts: [{ type: "text", text: "wait" }] })
      await started.promise
      const target = mode === "directory" || mode === "shutdown-waiter" ? workspace(ws.id, moved) : ws
      let retirement = mode === "release" ? releaseEmbeddedWorkspaceRuntime(ws.id)
        : mode === "shutdown" ? shutdownEmbeddedWorkspaceRuntimes() : undefined
      let reopened = false
      const replacement = ensureEmbeddedWorkspaceRuntime(target, { config: "skip" }).then((runtime) => {
        reopened = true
        return runtime
      })
      const concurrent = ensureEmbeddedWorkspaceRuntime(target, { config: "skip" })
      const acquisitions = Promise.allSettled([replacement, concurrent])
      await stopped.promise
      await Promise.resolve()
      expect(reopened).toBe(false)
      expect((await first.app.request(`http://runtime.test/session?directory=${encodeURIComponent(project)}`)).status).toBe(503)
      if (mode === "shutdown-waiter") retirement = shutdownEmbeddedWorkspaceRuntimes()
      let retired = false
      if (retirement) void retirement.then(() => { retired = true })
      await Promise.resolve()
      expect(retired).toBe(false)
      tail.resolve()
      if (mode === "shutdown-waiter") {
        expect(await acquisitions).toEqual([
          { status: "rejected", reason: expect.objectContaining({ message: "Embedded workspace runtime was shut down during acquisition" }) },
          { status: "rejected", reason: expect.objectContaining({ message: "Embedded workspace runtime was shut down during acquisition" }) },
        ])
        await retirement
        expect(await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })).not.toBe(first)
        return
      }
      const next = await replacement
      expect(await concurrent).toBe(next)
      expect(next).not.toBe(first)
      await retirement
      await prompt
      if (mode !== "directory") {
        const history = await next.app.request(`http://runtime.test/session/held-session/message?directory=${encodeURIComponent(project)}`)
        expect(history.status).toBe(200)
        expect(await history.text()).toContain("final producer text")
      }
    } finally {
      stopped.resolve()
      tail.resolve()
      await prompt
      await shutdownEmbeddedWorkspaceRuntimes()
      configureEmbeddedWorkspaceRuntime({ connectionProviders: [createAcpConnectionProvider(), createOpenCodeServerConnectionProvider()] })
      await removeWorkspaceRoot(root)
    }
  })

  test("an acquisition waiting for metadata never returns a concurrently released runtime", async () => {
    const { root, project } = await makeWorkspaceRoot("embedded-acquisition-release-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    let started!: () => void
    let release!: () => void
    const reading = new Promise<void>((resolve) => { started = resolve })
    const snapshot = new Promise<void>((resolve) => { release = resolve })
    try {
      const ws = workspace("ws_acquisition", project)
      const first = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      configureEmbeddedWorkspaceRuntime({ onSessionMetaSnapshot: () => { started(); return snapshot } })
      const acquisition = ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      await reading
      const retirement = releaseEmbeddedWorkspaceRuntime(ws.id)
      release()
      const replacement = await acquisition
      await retirement
      expect(replacement).not.toBe(first)
      expect(await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })).toBe(replacement)
    } finally {
      release()
      configureEmbeddedWorkspaceRuntime({})
      await shutdownTestRuntimes()
      await removeWorkspaceRoot(root)
    }
  })

  test("reports the composition its runtimes are actually mounted with", async () => {
    // A host that shares these runtimes must DECLARE this to the control
    // plane, which mints every client's event-stream scope from the
    // declaration and infers nothing. Read from the configured policy rather
    // than restated, so the declaration cannot drift from what is mounted:
    // an unsigned desktop leaves the unbound local policy in place, a signed
    // host injects an authority and becomes managed-private.
    expect(embeddedWorkspaceRuntimeSessionAuthority()).toBe("local")
    // Same answer through the port shared modules read it by: importing this
    // module installs the declaration, so the project catalog this process
    // publishes cannot describe a composition it did not mount.
    expect(localWorkspaceRuntimeSessionAuthority()).toBe("local")

    configureEmbeddedWorkspaceRuntime({
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
      expect(localWorkspaceRuntimeSessionAuthority()).toBe("managed-private")
    } finally {
      configureEmbeddedWorkspaceRuntime({})
    }
    expect(embeddedWorkspaceRuntimeSessionAuthority()).toBe("local")
    expect(localWorkspaceRuntimeSessionAuthority()).toBe("local")
  })

  test("a host with a local owner declares managed-private outward and local to its own window", async () => {
    // Two readers, two questions, and since the runtime decides the session
    // lifecycle per request they no longer have one answer. The control plane
    // is told how a RELAYED member is admitted, so it mints them a scoped
    // stream; the project catalog this process publishes is read by a client
    // on this machine's own loopback, which creates sessions with no
    // reservation because the daemon answers its own user directly.
    configureEmbeddedWorkspaceRuntime({
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
      loopbackSessionAuthority: "local",
    })
    try {
      expect(embeddedWorkspaceRuntimeSessionAuthority()).toBe("managed-private")
      expect(localWorkspaceRuntimeSessionAuthority()).toBe("local")
    } finally {
      configureEmbeddedWorkspaceRuntime({})
    }
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
      const created = await runtime.app.request(
        `http://runtime.test/session?directory=${encodeURIComponent(project)}&nativeHarness=pi`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer alice-proof",
            "x-claxedo-session-registration-operation": "reserve-private-session",
            [EMBEDDED_RELAY_HOST_AUTH_HEADER]: embeddedClaims("actor_alice", "Alice"),
          },
          body: JSON.stringify({ id: "private-session", title: "Private" }),
        },
      )
      expect(created.status, await created.clone().text()).toBe(201)
      const session = await created.json() as { id: string }

      const denied = await runtime.app.request(`http://runtime.test/session/${session.id}`, {
        headers: {
          authorization: "Bearer bob-proof",
          [EMBEDDED_RELAY_HOST_AUTH_HEADER]: embeddedClaims("actor_bob", "Bob"),
        },
      })
      expect(denied.status).toBe(403)
      await expect(denied.json()).resolves.toMatchObject({ error: { code: "session_private" } })

      const allowed = await runtime.app.request(`http://runtime.test/session/${session.id}`, {
        headers: {
          authorization: "Bearer alice-proof",
          [EMBEDDED_RELAY_HOST_AUTH_HEADER]: embeddedClaims("actor_alice", "Alice"),
        },
      })
      expect(allowed.status).toBe(200)
      expect(authorityCalls).toEqual([
        `actor_bob:read:${session.id}:Bearer bob-proof`,
        `actor_alice:read:${session.id}:Bearer alice-proof`,
      ])
    } finally {
      configureEmbeddedWorkspaceRuntime({})
      await shutdownTestRuntimes()
      await removeWorkspaceRoot(root)
    }
  })

  test("caches one runtime per workspace id and recreates when the directory changes", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-cache-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")

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
      await shutdownTestRuntimes()
      await removeWorkspaceRoot(root)
    }
  })

  test("announces every mounted runtime to an observer, replaying what is already mounted, and holds it until its disposal settles", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-observer-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")

    try {
      const first = await ensureEmbeddedWorkspaceRuntime(workspace("ws_observed", project), { config: "skip" })

      const announced: Array<{ directory: string; phase: string }> = []
      const observed: MountedEmbeddedWorkspaceRuntime[] = []
      const framed: WorkspaceEventStreamFrame[] = []
      // Reads the taps the way the host aggregate does: attach on "mounted",
      // let go on "disposed".
      const attached = new Map<MountedEmbeddedWorkspaceRuntime, () => void>()
      const stop = onEmbeddedWorkspaceRuntime((runtime, phase) => {
        announced.push({ directory: runtime.workspace.directory, phase })
        if (phase === "retired") return
        if (phase === "disposed") {
          attached.get(runtime)?.()
          attached.delete(runtime)
          return
        }
        observed.push(runtime)
        attached.set(runtime, runtime.frames.subscribe((frame) => framed.push(frame)))
      })

      expect(announced).toEqual([{ directory: project, phase: "mounted" }])
      // The observer is handed the runtime's own tap, not a copy of it.
      expect(observed[0].frames).toBe(first.host.frames)

      const lifecycle = {
        type: "session.lifecycle" as const,
        phase: "created" as const,
        directory: project,
        sessionID: "ses_observed",
        workspaceId: "ws_observed",
        ts: 1,
      }
      workspaceRuntimeBus.publish(lifecycle)
      expect(framed).toEqual([{ directory: project, payload: lifecycle }])

      const second = path.join(root, "project-2")
      await fs.mkdir(second, { recursive: true })
      await ensureEmbeddedWorkspaceRuntime(workspace("ws_observed_2", second), { config: "skip" })
      expect(announced.slice(1)).toEqual([{ directory: second, phase: "mounted" }])

      // One id whose directory moved is replaced, and the replacement is
      // announced only once the runtime it replaces has left the registry.
      const moved = path.join(root, "project-moved")
      await fs.mkdir(moved, { recursive: true })
      const replacement = await ensureEmbeddedWorkspaceRuntime(workspace("ws_observed", moved), { config: "skip" })
      expect(replacement).not.toBe(first)
      expect(announced.slice(2)).toEqual([
        { directory: project, phase: "retired" },
        { directory: project, phase: "disposed" },
        { directory: moved, phase: "mounted" },
      ])

      // Retirement is announced synchronously, before the host has aborted
      // anything; the terminal frames an aborted turn settles are published
      // from inside the disposal that follows, and this stream is the only
      // one left carrying them.
      const releasing = releaseEmbeddedWorkspaceRuntime("ws_observed_2")
      expect(announced.at(-1)).toEqual({ directory: second, phase: "retired" })
      const settling = {
        type: "agent.lifecycle" as const,
        tabId: "tab_observed_2",
        workspaceId: "ws_observed_2",
        eventType: "Idle" as const,
        outcome: "cancelled" as const,
      }
      workspaceRuntimeBus.publish(settling)
      await releasing
      expect(announced.at(-1)).toEqual({ directory: second, phase: "disposed" })
      expect(framed).toContainEqual({ directory: second, payload: settling })

      stop()
      await releaseEmbeddedWorkspaceRuntime("ws_observed")
      expect(announced).toHaveLength(7)
    } finally {
      await shutdownTestRuntimes()
      await removeWorkspaceRoot(root)
    }
  })

  test("the host aggregate carries every mounted runtime's frames, and keeps carrying a workspace's across a runtime replacement", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-aggregate-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    const handler = createHostAggregateEventsHandler({ observe: onEmbeddedWorkspaceRuntime })
    const abort = new AbortController()

    try {
      const other = path.join(root, "project-other")
      const moved = path.join(root, "project-moved")
      await fs.mkdir(other, { recursive: true })
      await fs.mkdir(moved, { recursive: true })
      await ensureEmbeddedWorkspaceRuntime(workspace("ws_agg_a", project), { config: "skip" })
      await ensureEmbeddedWorkspaceRuntime(workspace("ws_agg_b", other), { config: "skip" })

      const response = await new Hono()
        .get("/api/wr/events", handler)
        .request("http://127.0.0.1/api/wr/events", { signal: abort.signal })
      expect(response.status).toBe(200)
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let text = ""
      const until = async (marker: string) => {
        for (let i = 0; i < 40 && !text.includes(marker); i += 1) {
          const next = await reader.read()
          if (next.done) break
          text += decoder.decode(next.value, { stream: true })
        }
        return text
      }
      // The bootstrap heartbeat is written before the fanout attaches; reading
      // it is what proves the connection is attached before anything is published.
      await until("heartbeat")

      const lifecycle = (workspaceId: string, directory: string, sessionID: string) => ({
        type: "session.lifecycle" as const,
        phase: "created" as const,
        directory,
        sessionID,
        workspaceId,
        ts: 1,
      })

      // Both live workspaces reach one connection — the off-screen one has no
      // connection of its own and is exactly what the aggregate exists for.
      workspaceRuntimeBus.publish(lifecycle("ws_agg_a", project, "ses_a"))
      workspaceRuntimeBus.publish(lifecycle("ws_agg_b", other, "ses_b"))
      await until("ses_b")
      expect(text).toContain("ses_a")
      expect(text).toContain("ses_b")

      // One id whose directory moved is retired and replaced while the
      // connection stays open. The replacement's frames must reach the same
      // connection: the aggregate follows the registry, not a snapshot of it.
      await ensureEmbeddedWorkspaceRuntime(workspace("ws_agg_a", moved), { config: "skip" })
      workspaceRuntimeBus.publish(lifecycle("ws_agg_a", moved, "ses_a_moved"))
      workspaceRuntimeBus.publish(lifecycle("ws_agg_b", other, "ses_b_again"))
      await until("ses_b_again")
      expect(text).toContain("ses_a_moved")

      // A workspace with no live runtime has nothing live to say: released,
      // its frames reach nobody, while the workspace still mounted carries on.
      await releaseEmbeddedWorkspaceRuntime("ws_agg_b")
      workspaceRuntimeBus.publish(lifecycle("ws_agg_b", other, "ses_b_released"))
      workspaceRuntimeBus.publish(lifecycle("ws_agg_a", moved, "ses_a_last"))
      await until("ses_a_last")
      expect(text).not.toContain("ses_b_released")
    } finally {
      abort.abort()
      handler.close()
      await shutdownTestRuntimes()
      await removeWorkspaceRoot(root)
    }
  })

  test("config mode 'skip' does not apply runtime config; 'sync' does", async () => {
    const skip = await makeWorkspaceRoot("claxedo-embedded-skip-")
    const sync = await makeWorkspaceRoot("claxedo-embedded-sync-")
    process.env.CLAXEDO_DATA_DIR = path.join(skip.root, "data")

    try {
      const skipped = await ensureEmbeddedWorkspaceRuntime(workspace("ws_skip", skip.project), { config: "skip" })
      expect(skipped.host.detail().configApply).toMatchObject({ state: "idle", revision: 0 })

      const synced = await ensureEmbeddedWorkspaceRuntime(workspace("ws_sync", sync.project), { config: "sync" })
      expect(synced.host.detail().configApply).toMatchObject({ state: "applied", revision: 1 })

      // ...and neither mode leaves generated state in the user's checkout.
      expect(await workspaceIsClean(skip.project)).toEqual([])
      expect(await workspaceIsClean(sync.project)).toEqual([])
    } finally {
      await shutdownTestRuntimes()
      await removeWorkspaceRoot(skip.root, sync.root)
    }
  })

  test("a runtime created for a read selects the configured default harness before any config sync", async () => {
    const configured = await makeWorkspaceRoot("claxedo-embedded-default-harness-")
    const unconfigured = await makeWorkspaceRoot("claxedo-embedded-no-default-harness-")

    try {
      process.env.CLAXEDO_DATA_DIR = path.join(configured.root, "data")
      await saveUserConfig({ ...(await loadUserConfig()), defaultHarness: { kind: "native", harnessId: "pi" } })
      const runtime = await ensureEmbeddedWorkspaceRuntime(workspace("ws_default_harness", configured.project), { config: "skip" })
      expect(runtime.host.detail()).toMatchObject({
        harness: { kind: "native", harnessId: "pi" },
        configApply: { state: "idle", revision: 0 },
      })

      // No implicit fallback: a data dir without a configured default leaves the runtime without a harness.
      await shutdownTestRuntimes()
      process.env.CLAXEDO_DATA_DIR = path.join(unconfigured.root, "data")
      const bare = await ensureEmbeddedWorkspaceRuntime(workspace("ws_no_default_harness", unconfigured.project), { config: "skip" })
      expect(bare.host.detail().harness).toBeUndefined()
    } finally {
      await shutdownTestRuntimes()
      await removeWorkspaceRoot(configured.root, unconfigured.root)
    }
  })

  test("configureEmbeddedWorkspaceRuntime does not retroactively recreate a cached runtime", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-configure-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    try {
      const ws = workspace("ws_configure", project)
      const first = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })

      // Reconfiguring process-level options affects new runtimes only; an
      // already-cached runtime is not recreated.
      configureEmbeddedWorkspaceRuntime({ routeContributions: [] })
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
      configureEmbeddedWorkspaceRuntime({})
      await shutdownTestRuntimes()
      await removeWorkspaceRoot(root)
      await fs.rm(project + "-new", { recursive: true, force: true }).catch(() => {})
    }
  })

  test("shutdownEmbeddedWorkspaceRuntimes clears the cache", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-shutdown-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")

    try {
      const ws = workspace("ws_shutdown", project)
      const first = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })

      await shutdownEmbeddedWorkspaceRuntimes()

      // After shutdown the cache is empty, so the next ensure builds a fresh
      // runtime rather than returning the disposed one.
      const rebuilt = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      expect(rebuilt).not.toBe(first)
    } finally {
      await shutdownTestRuntimes()
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
    } finally {
      await shutdownTestRuntimes()
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
      await releaseEmbeddedWorkspaceRuntime(ws.id)
      expect(await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })).not.toBe(first)
    } finally {
      await shutdownTestRuntimes()
      await removeWorkspaceRoot(root)
    }
  })

  test("projects canonical runtime title events without publishing conversation events to the control plane", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-title-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    const { controlBus } = await import("@claxedo/server-core/platform/runtime/lib/bus")
    const events: import("@claxedo/agent-sdk-runtime").CompatEnvelope[] = []
    const controlPlaneEvents: unknown[] = []
    const unsubscribe = controlBus.subscribe((event) => controlPlaneEvents.push(event))
    configureEmbeddedWorkspaceRuntime({ onSessionMetaEvent: (event) => events.push(event) })
    try {
      const runtime = await ensureEmbeddedWorkspaceRuntime(workspace("ws_title", project), { config: "skip" })
      const created = await runtime.app.request(`http://runtime.test/session?directory=${encodeURIComponent(project)}&nativeHarness=pi`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Initial title" }),
      })
      expect(created.status, await created.clone().text()).toBe(201)
      const session = await created.json() as { id: string }
      events.length = 0
      controlPlaneEvents.length = 0
      const updated = await runtime.app.request(`http://runtime.test/session/${session.id}?directory=${encodeURIComponent(project)}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Canonical title" }),
      })
      expect(updated.status, await updated.clone().text()).toBe(200)
      expect(events).toContainEqual(expect.objectContaining({
        directory: project,
        payload: expect.objectContaining({
          type: "session.updated",
          properties: expect.objectContaining({ info: expect.objectContaining({ id: session.id, title: "Canonical title" }) }),
        }),
      }))
      expect(controlPlaneEvents).toEqual([])
    } finally {
      unsubscribe()
      configureEmbeddedWorkspaceRuntime({})
      await shutdownTestRuntimes()
      await removeWorkspaceRoot(root)
    }
  })

  test("reconciles persisted SDK runtime titles when rebuilding a workspace after restart", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-title-reconcile-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")

    try {
      const snapshots: unknown[][] = []
      configureEmbeddedWorkspaceRuntime({
        onSessionMetaSnapshot: (_workspace: Workspace, sessions: unknown[]) => {
          snapshots.push(sessions)
        },
      })

      const ws = workspace("ws_title_reconcile", project)
      const first = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      const created = await first.app.request(
        `http://localhost/session?directory=${encodeURIComponent(project)}&nativeHarness=pi`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Title generated before restart" }),
        },
      )
      expect(created.status).toBe(201)
      snapshots.length = 0
      await shutdownEmbeddedWorkspaceRuntimes()
      await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })

      expect(snapshots).toEqual([[
        expect.objectContaining({
          title: "Title generated before restart",
        }),
      ]])
    } finally {
      configureEmbeddedWorkspaceRuntime({})
      await shutdownTestRuntimes()
      await removeWorkspaceRoot(root)
    }
  })
})

describe("embedded runtime route ownership", () => {
  test("does not expose the removed OpenCode provider proxy", async () => {
    const { root, project } = await makeWorkspaceRoot("embedded-provider-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    try {
      const runtime = await ensureEmbeddedWorkspaceRuntime(workspace("ws_provider", project), { config: "skip" })
      const response = await runtime.app.request("http://runtime.test/provider")
      expect(response.status).toBe(404)
    } finally {
      await shutdownTestRuntimes()
      await removeWorkspaceRoot(root)
    }
  })
})

// These exercise host authorization/projection with a deterministic native wire
// peer. The workspace HTTP proof separately uses the real pinned Pi binary.
const originalPiExecutable = process.env.PI_EXECUTABLE
let piFixture: Awaited<ReturnType<typeof installFakePiRpc>>
beforeAll(async () => { piFixture = await installFakePiRpc(); process.env.PI_EXECUTABLE = piFixture.binary })
afterAll(async () => {
  if (originalPiExecutable === undefined) delete process.env.PI_EXECUTABLE
  else process.env.PI_EXECUTABLE = originalPiExecutable
  await piFixture.dispose()
})

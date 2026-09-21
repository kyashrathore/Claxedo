import { afterAll, beforeAll, afterEach, describe, expect, test } from "vitest"
import { installFakePiRpc } from "../../../../agent-sdk-runtime/src/test-utils/fake-pi-rpc.mjs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import {
  attachEmbeddedWorkspacePty,
  configureEmbeddedWorkspaceRuntime,
  cursorTranscriptRoot,
  embeddedWorkspaceRuntimeActivity,
  embeddedWorkspaceRuntimeOwners,
  embeddedWorkspaceRuntimeOwnership,
  embeddedWorkspaceRuntimeSessionAuthority,
  EmbeddedWorkspaceRuntimeRetirementUnresolvedError,
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
import { managedWorkspaceSessionAccessPolicy, Pty, type EmbeddedRelayHostIdentity } from "@claxedo/workspace-runtime"
import { volatileLaunchOwnership } from "@claxedo/agent-sdk-runtime/launch"
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
    // A host that serves these runtimes must DECLARE this to the control
    // plane, which mints every client's event-stream scope from the
    // declaration and infers nothing. Read from the configured policy rather
    // than restated, so the declaration cannot drift from what is mounted:
    // with nothing configured the unbound policy is local, and a configured
    // authority is managed-private.
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
    // Two readers, two questions: the runtime decides the session lifecycle
    // per request, so the two need not share an answer. The control plane is
    // told how a RELAYED member is admitted, so it mints them a scoped
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
      // The authority is ONE bundle: a composition that answered reads and
      // writes but not the stream capability would 503 every managed terminal
      // with `terminal_capability_authority_unavailable`.
      authority: {
        // The reservation is the plane's, made before the runtime was asked to
        // create anything; only the creation it names may start.
        authorizeSessionStart: (input) => input.actor.actorId === "actor_alice"
          && input.sessionId === "private-session"
          && input.registrationOperationId === "reserve-private-session",
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
      expect(second).toBe(first)

      const movedProject = path.join(root, "project-2")
      await fs.mkdir(movedProject, { recursive: true })
      const moved = await ensureEmbeddedWorkspaceRuntime(workspace("ws_cache", movedProject), { config: "skip" })
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

      expect(await workspaceIsClean(skip.project)).toEqual([])
      expect(await workspaceIsClean(sync.project)).toEqual([])
    } finally {
      await shutdownTestRuntimes()
      await removeWorkspaceRoot(skip.root, sync.root)
    }
  })

  test("concurrent adapter reads apply one initial snapshot without blocking stored reads", async () => {
    const { root, project } = await makeWorkspaceRoot("embedded-cold-adapter-")
    try {
      process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
      await saveUserConfig({ ...(await loadUserConfig()), defaultHarness: { kind: "native", harnessId: "pi" } })
      const runtime = await ensureEmbeddedWorkspaceRuntime(workspace("ws_cold_adapter", project), { config: "skip" })
      expect((await runtime.app.request("http://runtime.test/session")).status).toBe(200)
      expect(runtime.host.detail().configApply.state).toBe("idle")
      const responses = await Promise.all(["/permission/modes", "/session/capabilities", "/agent"].map((route) =>
        runtime.app.request(`http://runtime.test${route}?directory=${encodeURIComponent(project)}`)))
      expect(await responses[2]!.json()).toMatchObject({ error: { code: "unsupported_operation", harness: "pi", capability: "agents" } })
      expect(responses.map((response) => response.status)).toEqual([200, 200, 409])
      expect(runtime.host.detail().configApply).toMatchObject({ state: "applied", revision: 1 })
    } finally {
      await shutdownTestRuntimes()
      await removeWorkspaceRoot(root)
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

      configureEmbeddedWorkspaceRuntime({ routeContributions: [] })
      const afterConfigure = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      expect(afterConfigure).toBe(first)

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

  test("each mount is its own generation, and an owner names the turns and launches a replacement would inherit", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-generation-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")

    try {
      const ws = workspace("ws_generation", project)
      const first = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      const mounted = embeddedWorkspaceRuntimeOwners()
      expect(mounted).toHaveLength(1)
      expect(mounted[0]).toMatchObject({ workspaceId: ws.id, state: "serving", attempt: 0, turns: [] })
      expect(mounted[0]?.generation).toEqual(expect.any(String))

      // The durable read names the store's unresolved launches; nothing
      // prepared one, which is not the same as being unable to say.
      const ownership = await embeddedWorkspaceRuntimeOwnership()
      expect(ownership[0]?.launches).toEqual([])
      expect(ownership[0]?.launchesUnreadable).toBeUndefined()

      await releaseEmbeddedWorkspaceRuntime(ws.id)
      const remounted = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      expect(remounted).not.toBe(first)
      const next = embeddedWorkspaceRuntimeOwners()
      // A re-mount of the same id is a different owner, so a gate acknowledged
      // for the previous generation cannot carry to it.
      expect(next[0]?.generation).not.toBe(mounted[0]?.generation)
      expect(next[0]?.workspaceId).toBe(ws.id)
    } finally {
      await shutdownTestRuntimes()
      await removeWorkspaceRoot(root)
    }
  })

  test("an owner whose store is gone says its launches are unreadable, not that there are none", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-launches-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")

    try {
      const ws = workspace("ws_launch_unreadable", project)
      const runtime = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      // Teardown runs — so the store really is closed — and the step after it
      // refuses, which is the only way an owner is still listed with no store
      // left to ask.
      const teardown = runtime.host.dispose.bind(runtime.host)
      let refusals = 1
      ;(runtime.host as unknown as { dispose: () => Promise<void> }).dispose = async () => {
        await teardown()
        if (refusals-- > 0) throw new Error("post-teardown step refused")
      }

      try {
        expect(await releaseEmbeddedWorkspaceRuntime(ws.id)).toMatchObject({ state: "retire_failed" })
        const ownership = await embeddedWorkspaceRuntimeOwnership()
        expect(ownership).toHaveLength(1)
        expect(ownership[0]).toMatchObject({ workspaceId: ws.id, state: "retire_failed" })
        expect(ownership[0]?.launches, "an empty list would claim there is nothing to reconcile").toBeUndefined()
        expect(ownership[0]?.launchesUnreadable).toMatch(/disposed/)
      } finally {
        // Leave nothing fenced behind: a retirement this process never settles
        // is visible to every later case in this file.
        await releaseEmbeddedWorkspaceRuntime(ws.id, { retry: true })
      }
      expect(embeddedWorkspaceRuntimeOwners()).toEqual([])
    } finally {
      await shutdownTestRuntimes()
      await removeWorkspaceRoot(root)
    }
  })

  test("a failed retirement stays fenced and visible, and an explicit retry reruns only what is left", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-retire-failed-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")

    try {
      const ws = workspace("ws_retire_failed", project)
      const first = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      const teardown = first.host.dispose.bind(first.host)
      let refusals = 1
      let teardowns = 0
      ;(first.host as unknown as { dispose: () => Promise<void> }).dispose = () => {
        teardowns += 1
        return refusals-- > 0 ? Promise.reject(new Error("teardown refused")) : teardown()
      }

      const failed = await releaseEmbeddedWorkspaceRuntime(ws.id)
      expect(failed).toMatchObject({ workspaceId: ws.id, state: "retire_failed", attempt: 1 })
      expect(failed.error).toMatch(/teardown refused/)
      expect(embeddedWorkspaceRuntimeActivity().owners).toContainEqual(
        expect.objectContaining({ workspaceId: ws.id, state: "retire_failed", attempt: 1 }),
      )

      // Mounting must not reinterpret itself as permission to replace an owner
      // whose cleanup nothing verified.
      await expect(ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" }))
        .rejects.toThrow(EmbeddedWorkspaceRuntimeRetirementUnresolvedError)
      expect(await releaseEmbeddedWorkspaceRuntime(ws.id)).toMatchObject({ state: "retire_failed", attempt: 1 })
      expect(teardowns).toBe(1)

      expect(await releaseEmbeddedWorkspaceRuntime(ws.id, { retry: true }))
        .toMatchObject({ workspaceId: ws.id, state: "retired", attempt: 2 })
      expect(teardowns, "the retry reran the step that had not completed").toBe(2)
      expect(embeddedWorkspaceRuntimeActivity().owners).toEqual([])
      expect(await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })).not.toBe(first)
    } finally {
      await shutdownTestRuntimes()
      await removeWorkspaceRoot(root)
    }
  })

  test("shutdown reports every owner's retirement instead of losing the rest to one failure", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-shutdown-failed-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")

    try {
      const stuck = await ensureEmbeddedWorkspaceRuntime(workspace("ws_stuck", project), { config: "skip" })
      await ensureEmbeddedWorkspaceRuntime(workspace("ws_clean", project), { config: "skip" })
      const teardown = stuck.host.dispose.bind(stuck.host)
      ;(stuck.host as unknown as { dispose: () => Promise<void> }).dispose = () => Promise.reject(new Error("teardown refused"))

      const result = await shutdownEmbeddedWorkspaceRuntimes()
      expect(result.ok).toBe(false)
      expect(result.results.map((entry) => [entry.workspaceId, entry.state]))
        .toEqual([["ws_stuck", "retire_failed"], ["ws_clean", "retired"]])
      expect(result.results.find((entry) => entry.workspaceId === "ws_stuck")?.error).toMatch(/teardown refused/)
      ;(stuck.host as unknown as { dispose: () => Promise<void> }).dispose = teardown
      expect(await releaseEmbeddedWorkspaceRuntime("ws_stuck", { retry: true })).toMatchObject({ state: "retired" })
    } finally {
      await shutdownTestRuntimes()
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

/**
 * The in-process terminal attach, asked directly: this is the entrypoint the
 * daemon's WebSocket proxy calls instead of the runtime's own route, so the
 * questions the route would have asked have to be asked here.
 */
describe("attaching to an embedded workspace terminal", () => {
  const relayed = (role: "viewer" | "editor" = "editor"): EmbeddedRelayHostIdentity => ({
    principal_kind: "user",
    actor_id: "actor_member",
    actor_kind: "human",
    actor_public_id: "user_member",
    actor_name: "Member",
    org_id: "org_1",
    workspace_id: "ws_terminal",
    role,
  })

  function policyDeciding(verdict: (operation: string) => boolean) {
    const asked: string[] = []
    const denial = {
      allowed: false as const,
      status: 403 as const,
      code: "private_session",
      message: "Session is private",
    }
    const policy = managedWorkspaceSessionAccessPolicy({
      authority: {
        authorizeSessionRead: () => ({ allowed: true }),
        authorizeSessionWrite: () => ({ allowed: true }),
        authorizeSessionStream: (input) => {
          asked.push(input.operation)
          return verdict(input.operation)
            ? { allowed: true as const, lease: "stream-lease", expiresAt: Date.now() + 60_000 }
            : denial
        },
        registerSession: () => ({ allowed: true }),
        acquireTurn: () => denial,
        renewTurn: () => denial,
        releaseTurn: () => denial,
      },
    })
    return { policy, asked }
  }

  async function terminal(cwd: string, sessionId: string) {
    // These cases are about who may attach to a terminal, not about which
    // store owns its launch; a volatile owner records the launch and nothing
    // here reads it back.
    const info = await Pty.create({ command: "/bin/sh", cwd, sessionId }, volatileLaunchOwnership())
    Pty.commit(info.id)
    return info
  }

  test("a terminal outside the workspace is not this workspace's to attach to", async () => {
    const { root, project } = await makeWorkspaceRoot("embedded-terminal-foreign-")
    const elsewhere = await makeWorkspaceRoot("embedded-terminal-elsewhere-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    const pty = await terminal(elsewhere.project, "ses_1")
    try {
      const attach = await attachEmbeddedWorkspacePty({
        workspace: workspace("ws_terminal", project),
        ptyId: pty.id,
        method: "GET",
        path: `/api/wr/pty/${pty.id}/connect`,
      })

      expect(attach.ok).toBe(false)
      expect(attach.ok ? undefined : attach.response.status).toBe(404)
    } finally {
      await Pty.remove(pty.id)
      await shutdownTestRuntimes()
      await removeWorkspaceRoot(root, elsewhere.root)
    }
  })

  test("the identity the ingress verified is the one the mounted policy is asked about", async () => {
    const { root, project } = await makeWorkspaceRoot("embedded-terminal-identity-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    const refusing = policyDeciding(() => false)
    configureEmbeddedWorkspaceRuntime({ sessionAccessPolicy: refusing.policy })
    const pty = await terminal(project, "ses_1")
    try {
      const ws = workspace("ws_terminal", project)
      const request = {
        workspace: ws,
        ptyId: pty.id,
        authorization: "Bearer relay-token",
        method: "GET",
        path: `/api/wr/pty/${pty.id}/connect`,
      }

      const viewer = await attachEmbeddedWorkspacePty({ ...request, identity: relayed("viewer") })
      const member = await attachEmbeddedWorkspacePty({ ...request, identity: relayed() })
      const owner = await attachEmbeddedWorkspacePty(request)

      expect(viewer.ok ? undefined : viewer.response.status).toBe(403)
      expect(member.ok ? undefined : member.response.status).toBe(403)
      // A workspace viewer never reaches the session question at all.
      expect(refusing.asked).toEqual(["pty_read"])
      // The machine's own user carries no identity, so the policy has nobody
      // to refuse and the socket is its own.
      expect(owner.ok).toBe(true)
    } finally {
      configureEmbeddedWorkspaceRuntime({})
      await Pty.remove(pty.id)
      await shutdownTestRuntimes()
      await removeWorkspaceRoot(root)
    }
  })

  test("an admitted member gets a connection that reads the terminal and drops what it may not type", async () => {
    const { root, project } = await makeWorkspaceRoot("embedded-terminal-readonly-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    const readOnly = policyDeciding((operation) => operation === "pty_read")
    configureEmbeddedWorkspaceRuntime({ sessionAccessPolicy: readOnly.policy })
    const pty = await terminal(project, "ses_1")
    const received: string[] = []
    try {
      const attach = await attachEmbeddedWorkspacePty({
        workspace: workspace("ws_terminal", project),
        ptyId: pty.id,
        identity: relayed(),
        authorization: "Bearer relay-token",
        method: "GET",
        path: `/api/wr/pty/${pty.id}/connect`,
      })
      expect(attach.ok).toBe(true)
      if (!attach.ok) return

      attach.connection.onOpen({
        readyState: 1,
        bufferedAmount: 0,
        send: (data) => {
          received.push(typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer))
        },
        close: () => {},
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      attach.connection.onMessage("echo pwned\r")
      await new Promise((resolve) => setTimeout(resolve, 750))

      expect(received.length).toBeGreaterThan(0)
      expect(received.join("")).not.toContain("pwned")
      expect(readOnly.asked).toEqual(["pty_read", "pty_write"])
    } finally {
      configureEmbeddedWorkspaceRuntime({})
      await Pty.remove(pty.id)
      await shutdownTestRuntimes()
      await removeWorkspaceRoot(root)
    }
  })
})

describe("embedded runtime route ownership", () => {
  test("serves no /provider proxy of its own", async () => {
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

import { DurableObject } from "cloudflare:workers"
import type { DurableObjectState, Request as WorkerRequest, Response as WorkerResponse } from "@cloudflare/workers-types"
import { bounded, run, workspaceContainer, type ContainerStart, type WorkspaceContainer } from "./container-api"
import { interceptCredentialHosts, trustInterceptCa } from "./container-trust"
import { domRequest, workerResponse } from "./runtime-request"
import { ensureRuntimeProcess, runtimeServing, type RuntimeEnsure, type RuntimeHost, type RuntimeLaunch } from "./runtime-process"
import type { WorkerEnv } from "./worker-env"
import { IDLE_CHECK_FAILURE_LIMIT, IDLE_CHECK_MS, requestIdleStop, type WorkspaceIdle } from "./workspace-idle"
import { snapshotMissing } from "./workspace-snapshot"

const CREDENTIAL_HOSTS_KEY = "claxedo.credential-hosts"
const RUNTIME_LAUNCH_KEY = "claxedo.runtime-launch"
const CONTAINER_SOURCE_KEY = "claxedo.container-source"
const WORKSPACE_IDLE_KEY = "claxedo.workspace-idle"

export const RUNTIME_IMAGE = "runtime"
/** The runnable image carries the runtime and every agent harness, about 5.3 GB; standard-1 has an 8 GB disk. */
const INSTANCE = "standard-1"
/** Bounds what a container costs once nothing checks its runtime any more; while the idle alarm runs, the container is never inactive. */
const INACTIVITY_TIMEOUT_MS = 10 * 60_000
const CONTAINER_READY_TIMEOUT_MS = 240_000
const CONTAINER_READY_POLL_MS = 250

type CredentialHosts = { sandboxId: string; hosts: string[] }
// `ctx.exports` holds this Worker's own entrypoints, which only its generated
// types would name; the `Cloudflare.GlobalProps` this package compiles with
// name the API Worker's.
type SandboxExports = { CredentialEgress(options: { props: { sandboxId: string } }): unknown }

function sandboxExports(exports: object): exports is SandboxExports {
  return "CredentialEgress" in exports && typeof exports.CredentialEgress === "function"
}
/** What the running container started from: the image, or the snapshot of a checkpoint. */
type ContainerSource = { snapshotId?: string }

export type WorkspaceEnsureInput = {
  command: string
  env: Record<string, string>
  port: number
  reuseRunning: boolean
  /** The snapshot a stopped workspace's checkpoint names; its container starts from it, never from the image. */
  restore?: string
}

export type WorkspaceEnsure = RuntimeEnsure | { state: "snapshot-missing" }

/**
 * One workspace's sandbox: this Durable Object starts, restores, snapshots and
 * stops its container through `ctx.container`, and runs the workspace runtime
 * inside it.
 */
export class WorkspaceSandbox extends DurableObject<WorkerEnv> {
  private ensuring?: Promise<WorkspaceEnsure>

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env)
    if (ctx.container?.running) {
      void ctx.blockConcurrencyWhile(async () => {
        const container = workspaceContainer(ctx.container)
        await this.interceptRecordedHosts(container)
        await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS)
      })
    }
  }

  private container() {
    return workspaceContainer(this.ctx.container)
  }

  private runtimeHost(container: WorkspaceContainer): RuntimeHost {
    const storage = this.ctx.storage
    return {
      container,
      launches: {
        get: () => storage.get<RuntimeLaunch>(RUNTIME_LAUNCH_KEY),
        put: (launch) => storage.put(RUNTIME_LAUNCH_KEY, launch),
        delete: async () => {
          await storage.delete(RUNTIME_LAUNCH_KEY)
        },
      },
    }
  }

  /** An interception belongs to the running container and cannot be removed, so only a new container drops one. */
  private async interceptRecordedHosts(container: WorkspaceContainer) {
    const recorded = await this.ctx.storage.get<CredentialHosts>(CREDENTIAL_HOSTS_KEY)
    const exports: object = this.ctx.exports
    if (!sandboxExports(exports)) throw new Error("The Worker does not export CredentialEgress")
    const egress = exports.CredentialEgress({ props: { sandboxId: recorded?.sandboxId ?? "" } })
    await interceptCredentialHosts(container, recorded?.hosts ?? [], egress)
  }

  async setCredentialHosts(sandboxId: string, hosts: readonly string[]) {
    await this.ctx.storage.put(CREDENTIAL_HOSTS_KEY, { sandboxId, hosts: [...new Set(hosts)] } satisfies CredentialHosts)
    const container = this.container()
    if (container.running) await this.interceptRecordedHosts(container)
  }

  /** Records this lease generation's idle lifecycle; the health token is the runtime's config token, kept across boots. */
  async configureWorkspaceIdle(placement: Omit<WorkspaceIdle, "healthToken">) {
    const previous = await this.ctx.storage.get<WorkspaceIdle>(WORKSPACE_IDLE_KEY)
    const idle = { ...placement, healthToken: previous?.healthToken ?? `${crypto.randomUUID()}${crypto.randomUUID()}` }
    await this.ctx.storage.put(WORKSPACE_IDLE_KEY, idle)
    return idle.healthToken
  }

  /** Catalog refreshes and start retries overlap; they join one bring-up rather than cancel each other's container operations. */
  ensureWorkspace(input: WorkspaceEnsureInput) {
    if (this.ensuring) return this.ensuring
    const operation = this.bringUp(input)
    this.ensuring = operation
    return operation.finally(() => {
      if (this.ensuring === operation) this.ensuring = undefined
    })
  }

  private async bringUp(input: WorkspaceEnsureInput): Promise<WorkspaceEnsure> {
    const container = this.container()
    const source = await this.ctx.storage.get<ContainerSource>(CONTAINER_SOURCE_KEY)
    // A container running from anything but the checkpoint being restored holds files the lease no longer names.
    const replace = container.running && input.restore !== undefined && source?.snapshotId !== input.restore
    if (replace) await this.endContainer(container)
    if (!container.running) {
      try {
        await this.startContainer(container, input.restore)
      } catch (error) {
        if (snapshotMissing(error)) return { state: "snapshot-missing" }
        throw error
      }
    }
    return await ensureRuntimeProcess(this.runtimeHost(container), input.command, input.env, input.port, { reuseRunning: input.reuseRunning })
  }

  private async startContainer(container: WorkspaceContainer, snapshotId: string | undefined) {
    const image = container.images[RUNTIME_IMAGE]
    if (!snapshotId && !image) throw new Error(`The container application has no "${RUNTIME_IMAGE}" image`)
    const start: ContainerStart = {
      ...(snapshotId ? { containerSnapshot: { id: snapshotId } } : { image }),
      entrypoint: ["sleep", "infinity"],
      enableInternet: true,
      instance: INSTANCE,
    }
    await this.ctx.storage.delete(RUNTIME_LAUNCH_KEY)
    await this.ctx.storage.put(CONTAINER_SOURCE_KEY, (snapshotId ? { snapshotId } : {}) satisfies ContainerSource)
    try {
      container.start(start)
      await containerAccepting(container)
      await this.interceptRecordedHosts(container)
      await trustInterceptCa(container)
      await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS)
    } catch (error) {
      if (container.running) await container.destroy()
      throw error
    }
  }

  async workspaceRuntimeReady(port: number) {
    const container = this.container()
    return container.running && await runtimeServing(this.runtimeHost(container), port)
  }

  async watchWorkspaceIdle() {
    await this.ctx.storage.setAlarm(Date.now() + IDLE_CHECK_MS)
  }

  override async alarm() {
    await this.checkWorkspaceIdle()
  }

  /**
   * Every 30 seconds, while it lasts, this alarm both keeps the container
   * running and reads the runtime's idleness; once the control plane has
   * captured and stopped the lease, the object stops its own container.
   */
  private async checkWorkspaceIdle() {
    const idle = await this.ctx.storage.get<WorkspaceIdle>(WORKSPACE_IDLE_KEY)
    const container = this.container()
    if (!idle || !container.running) return
    try {
      const health = await container.getTcpPort(idle.port).fetch("http://runtime/api/wr/health", {
        headers: { authorization: `Bearer ${idle.healthToken}` },
      })
      const stopped = await requestIdleStop(idle, health, this.env)
      if (stopped) {
        await this.stopWorkspace(idle.epoch)
        return
      }
      if (idle.failures) await this.ctx.storage.put(WORKSPACE_IDLE_KEY, { ...idle, failures: 0 })
    } catch (error) {
      const failures = (idle.failures ?? 0) + 1
      console.error("workspace idle stop failed", { workspaceId: idle.workspaceId, epoch: idle.epoch, failures, error: String(error) })
      await this.ctx.storage.put(WORKSPACE_IDLE_KEY, { ...idle, failures })
      if (failures >= IDLE_CHECK_FAILURE_LIMIT) return
    }
    await this.ctx.storage.setAlarm(Date.now() + IDLE_CHECK_MS)
  }

  /** Stops the container for lease generation `epoch`; a generation that already took the sandbox over keeps it. */
  async stopWorkspace(epoch: number) {
    const idle = await this.ctx.storage.get<WorkspaceIdle>(WORKSPACE_IDLE_KEY)
    if (idle && idle.epoch !== epoch) return false
    await this.ctx.storage.deleteAlarm()
    await this.endContainer(this.container())
    return true
  }

  /** The writable root filesystem of the running container, as a snapshot a later start restores; `/run` and processes are not in it. */
  async snapshotWorkspace() {
    const container = this.container()
    if (!container.running) throw new Error("The workspace container is not running")
    const snapshot = await container.snapshotContainer({ name: "workspace" })
    return { snapshotId: snapshot.id, sizeBytes: snapshot.size }
  }

  async destroyWorkspace() {
    await this.ctx.storage.deleteAlarm()
    await this.endContainer(this.container())
    await this.ctx.storage.deleteAll()
  }

  private async endContainer(container: WorkspaceContainer) {
    if (container.running) await container.destroy()
    await this.ctx.storage.delete([RUNTIME_LAUNCH_KEY, CONTAINER_SOURCE_KEY])
  }

  /** The runtime proxy: never starts a container, because only `ensureWorkspace` knows whether to start from the image or a snapshot. */
  override async fetch(request: WorkerRequest): Promise<WorkerResponse> {
    const container = this.container()
    const idle = await this.ctx.storage.get<WorkspaceIdle>(WORKSPACE_IDLE_KEY)
    if (!container.running || !idle) return workerResponse(Response.json({ error: "The workspace machine is not running" }, { status: 503 }))
    return workerResponse(await container.getTcpPort(idle.port).fetch(domRequest(request)))
  }
}

/** `start()` returns before the container accepts work; the first `exec` that completes is readiness, and an exit while starting is the start's failure. */
async function containerAccepting(container: WorkspaceContainer, pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))) {
  const exited = container.monitor().then(
    () => new Error("The workspace container exited while starting"),
    (error: unknown) => error instanceof Error ? error : new Error(String(error)),
  )
  const deadline = Date.now() + CONTAINER_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const accepted = await Promise.race([
      bounded(run(container, ["true"]), "container readiness").then((output) => output.exitCode === 0, () => false),
      exited,
    ])
    if (accepted instanceof Error) throw accepted
    if (accepted) return
    await pause(CONTAINER_READY_POLL_MS)
  }
  throw new Error(`The workspace container did not accept commands within ${CONTAINER_READY_TIMEOUT_MS / 1000} seconds`)
}

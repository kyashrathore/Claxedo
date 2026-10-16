import { DurableObject } from "cloudflare:workers"
import type { DurableObjectState, Request as WorkerRequest, Response as WorkerResponse } from "@cloudflare/workers-types"
import { workspaceContainer, type WorkspaceContainer } from "./container-api"
import { CheckpointUnusableError, INACTIVITY_TIMEOUT_MS, startContainer, type ContainerOrigin, type ContainerSource } from "./container-start"
import { interceptCredentialHosts } from "./container-trust"
import { domRequest, workerResponse } from "./runtime-request"
import { runtimeMatches, versionBefore, workerRuntimeBuild } from "./runtime-integrity"
import { ensureRuntimeProcess, runtimeServing, type RuntimeEnsure, type RuntimeHost, type RuntimeLaunch } from "./runtime-process"
import type { WorkerEnv } from "./worker-env"
import { IDLE_CHECK_FAILURE_LIMIT, IDLE_CHECK_MS, requestIdleStop, type WorkspaceIdle } from "./workspace-idle"
import { recordSnapshot, snapshotBinding, type CheckpointUnusableCause } from "./workspace-snapshot"

const CREDENTIAL_HOSTS_KEY = "claxedo.credential-hosts"
const RUNTIME_LAUNCH_KEY = "claxedo.runtime-launch"
const CONTAINER_SOURCE_KEY = "claxedo.container-source"
const WORKSPACE_IDLE_KEY = "claxedo.workspace-idle"

type CredentialHosts = { sandboxId: string; hosts: string[] }
// `ctx.exports` holds this Worker's own entrypoints, which only its generated
// types would name; the `Cloudflare.GlobalProps` this package compiles with
// name the API Worker's.
type SandboxExports = { CredentialEgress(options: { props: { sandboxId: string } }): unknown }

function sandboxExports(exports: object): exports is SandboxExports {
  return "CredentialEgress" in exports && typeof exports.CredentialEgress === "function"
}

export type WorkspaceEnsureInput = {
  command: string
  env: Record<string, string>
  port: number
  reuseRunning: boolean
  /** The snapshot a stopped workspace's checkpoint names; its container starts from it, never from the image. */
  restore?: string
  /** The oldest runtime version the control plane lets a restore run. */
  minimumRuntimeVersion?: string
}

export type WorkspaceEnsure = RuntimeEnsure | { state: "checkpoint-unusable"; cause: CheckpointUnusableCause }

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

  private runtimeHost(container: WorkspaceContainer, source: ContainerSource): RuntimeHost {
    const storage = this.ctx.storage
    return {
      container,
      imageEnv: source.imageEnv,
      // Every launch hands the runtime the boot env, and an agent runs as root beside it.
      beforeLaunch: async () => {
        if (!await runtimeMatches(container, source.build)) throw new CheckpointUnusableError("runtime_modified")
      },
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
    try {
      const source = await this.readyContainer(container, input)
      return await ensureRuntimeProcess(this.runtimeHost(container, source), input.command, input.env, input.port, { reuseRunning: input.reuseRunning })
    } catch (error) {
      if (!(error instanceof CheckpointUnusableError)) throw error
      await this.endContainer(container)
      return { state: "checkpoint-unusable", cause: error.unusable }
    }
  }

  /** The running container this ensure may launch into, started when there is none or when the one running is not the checkpoint to restore. */
  private async readyContainer(container: WorkspaceContainer, input: WorkspaceEnsureInput) {
    const running = await this.ctx.storage.get<ContainerSource>(CONTAINER_SOURCE_KEY)
    if (container.running && running && (input.restore === undefined || running.snapshotId === input.restore)) return running
    const origin = await this.origin(input)
    await this.endContainer(container)
    const source = await startContainer(container, origin, () => this.interceptRecordedHosts(container))
    await this.ctx.storage.put(CONTAINER_SOURCE_KEY, source)
    return source
  }

  private async origin(input: WorkspaceEnsureInput): Promise<ContainerOrigin> {
    if (input.restore === undefined) {
      const image = workerRuntimeBuild(this.env)
      if (!image) throw new Error("The sandbox Worker was deployed without its runtime build identity")
      return { image }
    }
    const binding = await snapshotBinding(this.ctx.storage, input.restore)
    if (!binding) throw new CheckpointUnusableError("not_restorable")
    if (input.minimumRuntimeVersion && versionBefore(binding.build.version, input.minimumRuntimeVersion)) throw new CheckpointUnusableError("runtime_outdated")
    return { snapshotId: input.restore, binding }
  }

  async workspaceRuntimeReady(port: number) {
    const container = this.container()
    const source = await this.ctx.storage.get<ContainerSource>(CONTAINER_SOURCE_KEY)
    return container.running && source !== undefined && await runtimeServing(this.runtimeHost(container, source), port)
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

  /**
   * The writable root filesystem of the running container, as a snapshot a
   * later start of this sandbox restores; mounts, `/run` and processes are not
   * in it. The record of its runtime build and image environment stays here.
   */
  async snapshotWorkspace() {
    const container = this.container()
    const source = await this.ctx.storage.get<ContainerSource>(CONTAINER_SOURCE_KEY)
    if (!container.running || !source) throw new Error("The workspace container is not running")
    const snapshot = await container.snapshotContainer({ name: "workspace" })
    await recordSnapshot(this.ctx.storage, snapshot.id, { build: source.build, imageEnv: source.imageEnv, takenAt: Date.now() })
    return { snapshotId: snapshot.id, sizeBytes: snapshot.size, runtimeBuild: source.build.id }
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

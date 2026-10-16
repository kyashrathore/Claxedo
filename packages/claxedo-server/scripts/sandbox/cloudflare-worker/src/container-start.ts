import { bounded, run, type ContainerStart, type WorkspaceContainer } from "./container-api"
import { trustInterceptCa } from "./container-trust"
import { runtimeMatches, type RuntimeBuild } from "./runtime-integrity"
import { MEMORY_RUNTIME_ROOT, RUNTIME_ROOT } from "./runtime-process"
import { snapshotMissing, type CheckpointUnusableCause, type SnapshotBinding } from "./workspace-snapshot"

export const RUNTIME_IMAGE = "runtime"
/** The runnable image carries the runtime and every agent harness, about 5.3 GB; standard-1 has an 8 GB disk. */
const INSTANCE = "standard-1"
/** Bounds what a container costs once nothing checks its runtime any more; while the idle alarm runs, the container is never inactive. */
export const INACTIVITY_TIMEOUT_MS = 10 * 60_000
/**
 * The container's main process. `sleep` alone never waits for children, so
 * every process reparented to it (a git a harness left behind) stays a zombie
 * in its launch's process group, which then never reads as exited; tini reaps
 * them. The image's environment stays the main process's.
 */
export const CONTAINER_ENTRYPOINT = ["/usr/bin/tini", "--", "sleep", "infinity"]
const CONTAINER_READY_TIMEOUT_MS = 240_000
const CONTAINER_READY_POLL_MS = 250

/** What the running container started from, and the runtime build, image environment and main process it carries. */
export type ContainerSource = { snapshotId?: string; build: RuntimeBuild; imageEnv: Record<string, string>; entrypoint: string[] }

export type ContainerOrigin = { image: RuntimeBuild } | { snapshotId: string; binding: SnapshotBinding }

/** A checkpoint this sandbox will not restore, for the reason the person's Start fresh answers. */
export class CheckpointUnusableError extends Error {
  constructor(readonly unusable: CheckpointUnusableCause) {
    super(`checkpoint unusable: ${unusable}`)
    this.name = "CheckpointUnusableError"
  }
}

/** `start()` returns before the container accepts work; the first `exec` that completes is readiness, and an exit while starting is the start's failure. */
async function containerAccepting(container: WorkspaceContainer) {
  const exited = container.monitor().then(
    () => new Error("The workspace container exited while starting"),
    (error: unknown) => error instanceof Error ? error : new Error(String(error)),
  )
  const deadline = Date.now() + CONTAINER_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const accepted = await Promise.race([
      bounded(run(container, ["true"]), "container readiness", 30_000).then((output) => output.exitCode === 0, () => false),
      exited,
    ])
    if (accepted instanceof Error) throw accepted
    if (accepted) return
    await new Promise<void>((resolve) => setTimeout(resolve, CONTAINER_READY_POLL_MS))
  }
  throw new Error(`The workspace container did not accept commands within ${CONTAINER_READY_TIMEOUT_MS / 1000} seconds`)
}

/**
 * The image's environment, read from the main process of a container that has
 * just started from the image, before anything else has run in it. The
 * platform's own variables describe that container alone.
 */
async function pristineImageEnv(container: WorkspaceContainer) {
  const environ = await bounded(run(container, ["cat", "/proc/1/environ"]), "container environment read")
  return Object.fromEntries(environ.stdout.split("\0").flatMap((entry) => {
    const at = entry.indexOf("=")
    return at > 0 && !entry.startsWith("CLOUDFLARE_") ? [[entry.slice(0, at), entry.slice(at + 1)]] : []
  }))
}

async function memoryRuntimeRoot(container: WorkspaceContainer) {
  const mounted = await bounded(run(container, ["sh", "-c", MEMORY_RUNTIME_ROOT, "memory", RUNTIME_ROOT]), "runtime directory mount")
  if (mounted.exitCode !== 0) throw new Error("The workspace container has no memory-backed runtime directory")
}

/**
 * Starts the container from this Worker's image or from a snapshot this
 * sandbox recorded, and readies it for a runtime launch: credential
 * interception (`intercept`), the interception CA, a memory-backed launch
 * directory, the runtime files checked against the build they must be, and the
 * inactivity bound. A container that fails any step is destroyed.
 */
export async function startContainer(container: WorkspaceContainer, origin: ContainerOrigin, intercept: () => Promise<void>): Promise<ContainerSource> {
  const image = container.images[RUNTIME_IMAGE]
  if ("image" in origin && !image) throw new Error(`The container application has no "${RUNTIME_IMAGE}" image`)
  const start: ContainerStart = {
    ...("snapshotId" in origin
      ? { containerSnapshot: { id: origin.snapshotId }, env: origin.binding.imageEnv, entrypoint: origin.binding.entrypoint }
      : { image, entrypoint: CONTAINER_ENTRYPOINT }),
    enableInternet: true,
    instance: INSTANCE,
  }
  try {
    container.start(start)
    await containerAccepting(container)
    const source: ContainerSource = "snapshotId" in origin
      ? { snapshotId: origin.snapshotId, build: origin.binding.build, imageEnv: origin.binding.imageEnv, entrypoint: origin.binding.entrypoint }
      : { build: origin.image, imageEnv: await pristineImageEnv(container), entrypoint: CONTAINER_ENTRYPOINT }
    await intercept()
    await trustInterceptCa(container)
    await memoryRuntimeRoot(container)
    if (!await runtimeMatches(container, source.build)) {
      if ("snapshotId" in origin) throw new CheckpointUnusableError("runtime_modified")
      throw new Error(`The runtime image does not carry this Worker's runtime build ${origin.image.id}`)
    }
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS)
    return source
  } catch (error) {
    if (container.running) await container.destroy()
    throw snapshotMissing(error) ? new CheckpointUnusableError("expired") : error
  }
}

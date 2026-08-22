// Types only at module scope: this file is in the static import graph of every
// driver (they read SANDBOX_IMAGE), so a value import here would load the whole
// Daytona SDK — axios included — into every embedder and test process. The SDK
// values below are imported lazily, inside the snapshot-build paths that are
// the only places that need them.
import type { Daytona, Image } from "@daytona/sdk"
export { RUNTIME_DIR, WORKSPACE_RUNTIME_PORT, WORKSPACE_DIR } from "./defaults"
export {
  SNAPSHOT_SCHEMA_VERSION,
  snapshotVersion,
  defaultSandboxImage,
  defaultSnapshotName,
} from "./image-name"
import { defaultSandboxImage, defaultSnapshotName, sandboxImageRepository } from "./image-name"

/**
 * Sink for snapshot-build progress. Every message here reports a long
 * operation an operator is actively waiting on — a snapshot build takes
 * minutes, and the Daytona builder's `onLogs` stream is the only view into
 * whether it is progressing or wedged.
 *
 * Defaults to `console.info`, deliberately unconditional: the same reasoning as
 * `onEgressUnenforced` in index.ts — someone who never wires a sink still sees
 * the build. Pass your own to route it into a logger; pass `() => {}` only if
 * you have another way to observe the build.
 */
export type SandboxImageLogSink = (message: string, context?: Record<string, unknown>) => void

export type SandboxImageOptions = {
  log?: SandboxImageLogSink
}

function defaultImageLogSink(message: string, context?: Record<string, unknown>) {
  if (context) console.info(message, context)
  else console.info(message)
}

export const SANDBOX_IMAGE_REPOSITORY = sandboxImageRepository()

export const SANDBOX_IMAGE = process.env.CLAXEDO_SANDBOX_IMAGE || defaultSandboxImage()

export const SNAPSHOT_NAME = process.env.CLAXEDO_SNAPSHOT_NAME
  || defaultSnapshotName()

export async function buildSandboxImage(): Promise<Image> {
  const { Image } = await import("@daytona/sdk")
  return Image.base(SANDBOX_IMAGE)
}

function snapshotUsable(state: unknown) {
  return state === "ready" || state === "active"
}

async function createSnapshot(daytona: Daytona, log: SandboxImageLogSink): Promise<string> {
  log("Creating sandbox snapshot (this may take a few minutes)...", { name: SNAPSHOT_NAME })
  await daytona.snapshot.create(
    { name: SNAPSHOT_NAME, image: await buildSandboxImage() },
    {
      timeout: 120,
      onLogs: (chunk) => log("[snapshot]", { text: chunk }),
    },
  )
  return SNAPSHOT_NAME
}

export async function ensureSnapshot(daytona: Daytona, options: SandboxImageOptions = {}): Promise<string> {
  const log = options.log ?? defaultImageLogSink
  try {
    const existing = await daytona.snapshot.get(SNAPSHOT_NAME) as any
    if (existing.state === "inactive") {
      log("Snapshot is inactive, reactivating...", { name: SNAPSHOT_NAME, id: existing.id })
      await (daytona.snapshot as any).activate({ id: existing.id })
      for (let i = 0; i < 120; i++) {
        const snap = await daytona.snapshot.get(SNAPSHOT_NAME) as any
        if (snapshotUsable(snap.state)) return SNAPSHOT_NAME
        if (snap.state === "error") throw new Error(`Snapshot activation failed: ${snap.errorReason}`)
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
      throw new Error("Snapshot activation timed out")
    }
    if (existing.state === "building") {
      log("Snapshot is building, waiting (up to 10 min)...", { name: SNAPSHOT_NAME })
      for (let i = 0; i < 300; i++) {
        const snap = await daytona.snapshot.get(SNAPSHOT_NAME) as any
        if (snapshotUsable(snap.state)) return SNAPSHOT_NAME
        if (snap.state === "error") throw new Error(`Snapshot build failed: ${snap.errorReason}`)
        if (i % 15 === 0) log("Still waiting for snapshot...", { state: snap.state, elapsed: `${i * 2}s` })
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
      throw new Error("Snapshot build timed out after 10 minutes")
    }
    return SNAPSHOT_NAME
  } catch (err) {
    const { DaytonaNotFoundError } = await import("@daytona/sdk")
    if (!(err instanceof DaytonaNotFoundError)) throw err
  }
  return createSnapshot(daytona, log)
}

import { Daytona, Image, DaytonaNotFoundError } from "@daytona/sdk"
export { RUNTIME_DIR, WORKSPACE_RUNTIME_PORT, WORKSPACE_DIR } from "./defaults"
export {
  SNAPSHOT_SCHEMA_VERSION,
  snapshotVersion,
  defaultSandboxImage,
  defaultSnapshotName,
} from "./image-name"
import { defaultSandboxImage, defaultSnapshotName, sandboxImageRepository } from "./image-name"

const log = {
  info(_message: string, _context?: Record<string, unknown>) {},
}

export const SANDBOX_IMAGE_REPOSITORY = sandboxImageRepository()

export const SANDBOX_IMAGE = process.env.CLAXEDO_SANDBOX_IMAGE || defaultSandboxImage()

export const SNAPSHOT_NAME = process.env.CLAXEDO_SNAPSHOT_NAME
  || defaultSnapshotName()

export function buildSandboxImage(): Image {
  return Image.base(SANDBOX_IMAGE)
}

function snapshotUsable(state: unknown) {
  return state === "ready" || state === "active"
}

async function createSnapshot(daytona: Daytona): Promise<string> {
  log.info("Creating sandbox snapshot (this may take a few minutes)...", { name: SNAPSHOT_NAME })
  await daytona.snapshot.create(
    { name: SNAPSHOT_NAME, image: buildSandboxImage() },
    {
      timeout: 120,
      onLogs: (chunk) => log.info("[snapshot]", { text: chunk }),
    },
  )
  return SNAPSHOT_NAME
}

export async function ensureSnapshot(daytona: Daytona): Promise<string> {
  try {
    const existing = await daytona.snapshot.get(SNAPSHOT_NAME) as any
    if (existing.state === "inactive") {
      log.info("Snapshot is inactive, reactivating...", { name: SNAPSHOT_NAME, id: existing.id })
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
      log.info("Snapshot is building, waiting (up to 10 min)...", { name: SNAPSHOT_NAME })
      for (let i = 0; i < 300; i++) {
        const snap = await daytona.snapshot.get(SNAPSHOT_NAME) as any
        if (snapshotUsable(snap.state)) return SNAPSHOT_NAME
        if (snap.state === "error") throw new Error(`Snapshot build failed: ${snap.errorReason}`)
        if (i % 15 === 0) log.info("Still waiting for snapshot...", { state: snap.state, elapsed: `${i * 2}s` })
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
      throw new Error("Snapshot build timed out after 10 minutes")
    }
    return SNAPSHOT_NAME
  } catch (err) {
    if (!(err instanceof DaytonaNotFoundError)) throw err
  }
  return createSnapshot(daytona)
}

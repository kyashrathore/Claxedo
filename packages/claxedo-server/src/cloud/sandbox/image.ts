import { Daytona, Image, DaytonaNotFoundError } from "@daytonaio/sdk"
import { Log } from "../../log"

const log = Log.create({ service: "sandbox-image" })

export const RUNTIME_PORT = 3002
export const WORKSPACE_DIR = "/workspace"
export const RUNTIME_DIR = "/opt/workspace-runtime"

/** Shared Docker image with tools + workspace-runtime pre-installed. */
export const SANDBOX_IMAGE = process.env.CLAXEDO_SANDBOX_IMAGE || "ghcr.io/kyashrathore/claxedo-sandbox:latest"

const SNAPSHOT_NAME = process.env.CLAXEDO_SNAPSHOT_NAME || "claxedo-workspace-runtime-v7-20260422-codexauth"

export function buildSandboxImage(): Image {
  return Image.base(SANDBOX_IMAGE)
}

async function createSnapshot(daytona: Daytona): Promise<string> {
  log.info("Creating sandbox snapshot (this may take a few minutes)...", { name: SNAPSHOT_NAME })
  const image = buildSandboxImage()
  await daytona.snapshot.create(
    { name: SNAPSHOT_NAME, image },
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
        if (snap.state === "ready") return SNAPSHOT_NAME
        if (snap.state === "error") throw new Error(`Snapshot activation failed: ${snap.errorReason}`)
        await new Promise((r) => setTimeout(r, 2000))
      }
      throw new Error("Snapshot activation timed out")
    }
    if (existing.state === "building") {
      log.info("Snapshot is building, waiting (up to 10 min)...", { name: SNAPSHOT_NAME })
      for (let i = 0; i < 300; i++) {
        const snap = await daytona.snapshot.get(SNAPSHOT_NAME) as any
        if (snap.state === "ready") return SNAPSHOT_NAME
        if (snap.state === "error") throw new Error(`Snapshot build failed: ${snap.errorReason}`)
        if (i % 15 === 0) log.info("Still waiting for snapshot...", { state: snap.state, elapsed: `${i * 2}s` })
        await new Promise((r) => setTimeout(r, 2000))
      }
      throw new Error("Snapshot build timed out after 10 minutes")
    }
    return SNAPSHOT_NAME
  } catch (err) {
    if (!(err instanceof DaytonaNotFoundError)) throw err
  }
  return createSnapshot(daytona)
}

import path from "node:path"
import { url } from "../config"
import { requestJson } from "../http"
import { requireAccessToken } from "../auth/token-store"
import { readHostState, removeHostRecord } from "../host/state"

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function down(args: string[]) {
  const workspaceId = args.find((arg) => !arg.startsWith("-"))
  const directory = path.resolve(".")
  const state = await readHostState()
  const record = workspaceId
    ? state.hosts.find((item) => item.workspaceId === workspaceId)
    : state.hosts.find((item) => item.directory === directory)
  if (!record)
    throw new Error(workspaceId ? `No local host found for ${workspaceId}` : "No local host found for this directory")
  await requestJson({
    url: url(record.controlPlaneUrl, `/api/workspace/${encodeURIComponent(record.workspaceId)}/user-hosted/pause`),
    token: await requireAccessToken(),
    body: {
      hostId: record.hostId,
      paused: true,
    },
  }).catch((err: unknown) => {
    console.error(`Remote pause failed: ${err instanceof Error ? err.message : String(err)}`)
  })
  if (record.pid && record.pid !== process.pid && alive(record.pid)) process.kill(record.pid, "SIGTERM")
  await removeHostRecord({ workspaceId: record.workspaceId })
  console.log(`Stopped ${record.workspaceId}`)
}

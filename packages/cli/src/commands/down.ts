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

function warn(label: string, err: unknown) {
  console.error(`${label}: ${err instanceof Error ? err.message : String(err)}`)
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
  const token = await requireAccessToken()

  // Withdraw the OWNER's assignment for this workspace only. Routing needs
  // intent AND consent, so dropping intent stops this workspace immediately
  // while every other project served from the same machine keeps running —
  // which is the difference machine-wide enrollment buys: `down` in one repo
  // is no longer a decision about the laptop.
  await requestJson({
    url: url(record.controlPlaneUrl, `/api/workspace/${encodeURIComponent(record.workspaceId)}/host-assignment`),
    method: "DELETE",
    token,
  }).catch((err: unknown) => warn("Remote unassign failed", err))

  // The last one out pauses the machine. An enrollment with nothing assigned
  // routes nothing, but leaving it live means the laptop keeps a renewable
  // lease it is not using; pausing makes "no projects up" and "this machine is
  // not serving" the same state on the devices screen.
  const remaining = state.hosts.filter((item) => item.workspaceId !== record.workspaceId)
  if (!remaining.some((item) => item.hostId === record.hostId)) {
    await requestJson({
      url: url(record.controlPlaneUrl, "/api/claxedo/host/enrollments/pause"),
      token,
      body: { hostId: record.hostId, paused: true },
    }).catch((err: unknown) => warn("Remote pause failed", err))
  }

  if (record.pid && record.pid !== process.pid && alive(record.pid)) process.kill(record.pid, "SIGTERM")
  await removeHostRecord({ workspaceId: record.workspaceId })
  console.log(`Stopped ${record.workspaceId}`)
}

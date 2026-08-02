import { readHostState } from "../host/state"

function alive(pid: number | undefined) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function status() {
  const state = await readHostState()
  if (state.hosts.length === 0) {
    console.log("No local Claxedo hosts")
    return
  }
  for (const host of state.hosts) {
    const health = alive(host.pid) ? "online" : "offline"
    const runtime = host.runtimePort ? `http://127.0.0.1:${host.runtimePort}` : "runtime unknown"
    console.log(`${host.workspaceId}  ${health}  ${runtime}  ${host.directory}`)
  }
}

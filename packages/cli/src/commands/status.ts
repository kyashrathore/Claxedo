import fs from "node:fs/promises"
import { hostPublicKeyFingerprint } from "@claxedo/host-connector/host-identity"
import { effectiveRoots, type HostState } from "@claxedo/host-connector/host-state"
import { connectPaths, connectStateStore } from "../connect/paths"

export type StatusDeps = {
  load: () => Promise<HostState | undefined>
  stateFile: string
  resolvePath: (target: string) => Promise<string>
  pidAlive: (pid: number) => boolean
  now: () => number
  log: (line: string) => void
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function defaultStatusDeps(): StatusDeps {
  return {
    load: () => connectStateStore().load(),
    stateFile: connectPaths().stateFile,
    resolvePath: (target) => fs.realpath(target),
    pidAlive: processAlive,
    now: () => Date.now(),
    log: (line) => console.log(line),
  }
}

/** Online means the connect process is alive AND the lease the control plane issued on its last good beat has not expired. */
export function hostOnline(state: HostState, deps: Pick<StatusDeps, "pidAlive" | "now">) {
  const run = state.run
  if (!run || !deps.pidAlive(run.pid)) return false
  return run.lease_expires_at !== undefined && deps.now() <= run.lease_expires_at
}

function iso(value: number | undefined) {
  return value === undefined ? "-" : new Date(value).toISOString()
}

export async function statusLines(deps: StatusDeps): Promise<string[]> {
  const state = await deps.load()
  if (!state) return [`No connect host on this machine (${deps.stateFile} absent). \`claxedo connect --help\` explains enrollment.`]
  const fingerprint = await hostPublicKeyFingerprint(state.private_key_jwk).catch(() => "-")
  const online = hostOnline(state, deps)
  const lines = [
    "Machine",
    `  host id      ${state.host_id}`,
    `  fingerprint  ${fingerprint}`,
    `  control      ${state.control_plane_url}`,
  ]
  if (state.enrollment) {
    lines.push(
      `  enrollment   ${state.enrollment.enrollment_id} (via ${state.enrollment.enrolled_via}, owner ${state.enrollment.owner_display || "-"})`,
    )
  } else if (state.bootstrap) {
    lines.push(`  enrollment   pending: redeem of invitation ${state.bootstrap.invitation_id} did not complete`)
  } else {
    lines.push("  enrollment   none")
  }
  const run = state.run
  lines.push(
    `  generation   ${run?.generation ?? "-"}`,
    `  lease        expires ${iso(run?.lease_expires_at)}; last beat ok ${iso(run?.last_beat_ok_at)}`,
    `  status       ${online ? "online" : "offline"}${run && !online ? ` (pid ${run.pid} ${deps.pidAlive(run.pid) ? "alive, lease stale" : "gone"})` : ""}`,
  )
  if (run?.last_beat_error) lines.push(`  last error   ${run.last_beat_error}`)
  const roots = await effectiveRoots(state, deps.resolvePath)
  lines.push(`  roots        ${roots.length ? roots.join(", ") : "none (nothing is servable)"}`)
  if (state.service) lines.push(`  service      ${state.service.kind} ${state.service.unit}`)
  const served = run?.served ?? []
  lines.push(served.length ? "Served folders" : "Served folders: none")
  for (const entry of served) {
    lines.push(`  ${entry.workspace_id}  revision ${entry.revision}  ${entry.connected && online ? "connected" : "not connected"}`)
  }
  return lines
}

export async function status(deps: StatusDeps = defaultStatusDeps()) {
  for (const line of await statusLines(deps)) deps.log(line)
}

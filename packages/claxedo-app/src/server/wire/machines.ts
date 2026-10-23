import { asString, isFiniteNumber, isNonBlankString, isRecord, isStringList } from "@claxedo/helpers/guards"
import { machineId } from "../ids"
import type { Machine, MachineAssignment, MachineBlock, MachineBlockReason, MachineEnrollment, MachineProbe, MachineRoot, MachineUpdate } from "../machine-types"

const DEVICE_STATES: ReadonlySet<unknown> = new Set(["online", "offline", "paused"])

const BLOCK_REASONS: Readonly<Record<string, MachineBlockReason>> = {
  linger_off: "lingerOff",
  user_manager_unreachable: "userManagerUnreachable",
  waiting_for_logon: "waitingForLogon",
  desktop_daemon: "desktopDaemon",
  stopped: "stopped",
}

type DeviceRow = {
  readonly host_id: string
  readonly enrollment_id: string
  readonly display_name: string
  readonly last_seen_at: number
  readonly state: "online" | "offline" | "paused"
  readonly serving_workspace_ids: readonly string[]
  readonly cli_version?: unknown
  readonly os?: unknown
  readonly arch?: unknown
  readonly roots?: unknown
  readonly blocked?: unknown
  readonly update?: unknown
}

function isDeviceRow(value: unknown): value is DeviceRow {
  return isRecord(value)
    && isNonBlankString(value.host_id)
    && isNonBlankString(value.enrollment_id)
    && typeof value.display_name === "string"
    && isFiniteNumber(value.last_seen_at)
    && DEVICE_STATES.has(value.state)
    && isStringList(value.serving_workspace_ids)
}

function assignmentFromWire(raw: unknown): MachineAssignment[] {
  if (!isRecord(raw) || !isNonBlankString(raw.workspace_id)) return []
  return [{ workspaceId: raw.workspace_id, name: asString(raw.display_name) ?? raw.workspace_id, directory: asString(raw.directory) ?? "" }]
}

function rootsFromWire(raw: unknown): MachineRoot[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.flatMap((root) => (isRecord(root) && isNonBlankString(root.path)
    ? [{ path: root.path, retires: Array.isArray(root.retires) ? root.retires.flatMap(assignmentFromWire) : [] }]
    : []))
}

function blockFromWire(raw: unknown): MachineBlock | undefined {
  if (!isRecord(raw) || !isNonBlankString(raw.fix) || !isFiniteNumber(raw.reported_at)) return undefined
  const reason = typeof raw.reason === "string" ? BLOCK_REASONS[raw.reason] : undefined
  return reason ? { reason, fix: raw.fix, reportedAt: raw.reported_at } : undefined
}

function updateFromWire(raw: unknown): MachineUpdate | undefined {
  return isRecord(raw) && isNonBlankString(raw.version) && isNonBlankString(raw.command) ? { version: raw.version, command: raw.command } : undefined
}

function enrollmentFromDevice(row: DeviceRow): MachineEnrollment {
  const cliVersion = isNonBlankString(row.cli_version) ? row.cli_version : undefined
  const os = isNonBlankString(row.os) ? row.os : undefined
  const arch = isNonBlankString(row.arch) ? row.arch : undefined
  const roots = rootsFromWire(row.roots)
  const blocked = blockFromWire(row.blocked)
  const update = updateFromWire(row.update)
  return {
    hostId: row.host_id,
    enrollmentId: row.enrollment_id,
    lastSeenAt: row.last_seen_at,
    servingWorkspaceIds: row.serving_workspace_ids,
    ...(cliVersion ? { cliVersion } : {}),
    ...(os ? { os } : {}),
    ...(arch ? { arch } : {}),
    ...(roots ? { roots } : {}),
    ...(blocked ? { blocked } : {}),
    ...(update ? { update } : {}),
  }
}

function machineFromDevice(row: DeviceRow, self: string | undefined): Machine {
  return {
    id: machineId(row.enrollment_id),
    name: row.display_name,
    online: row.state === "online",
    ...(row.state === "paused" ? { paused: true } : {}),
    isThisMachine: self === row.enrollment_id,
    enrolled: true,
    enrollment: enrollmentFromDevice(row),
  }
}

export function machinesFromDevices(rows: readonly unknown[], self: string | undefined): Machine[] {
  return rows.flatMap((row) => {
    if (isDeviceRow(row)) return [machineFromDevice(row, self)]
    console.error("The account's devices list sent a machine row this app cannot read", { row })
    return []
  })
}

export const RUNTIME_PROBE_PATH = "/global/health"

export function runtimeProbeFromWire(raw: unknown): MachineProbe {
  const answer = isRecord(raw) ? raw : {}
  return answer.healthy === true ? { kind: "answered" } : { kind: "unhealthy", status: asString(answer.status) ?? "unknown" }
}

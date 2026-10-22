import { asString, isFiniteNumber, isNonBlankString, isRecord, isStringList } from "@claxedo/helpers/guards"
import { machineId } from "../ids"
import type { Machine, MachineProbe } from "../machine-types"

const DEVICE_STATES: ReadonlySet<unknown> = new Set(["online", "offline", "paused"])

type DeviceRow = {
  readonly host_id: string
  readonly enrollment_id: string
  readonly display_name: string
  readonly last_seen_at: number
  readonly state: "online" | "offline" | "paused"
  readonly serving_workspace_ids: readonly string[]
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

function machineFromDevice(row: DeviceRow, self: string | undefined): Machine {
  return {
    id: machineId(row.enrollment_id),
    name: row.display_name,
    online: row.state === "online",
    ...(row.state === "paused" ? { paused: true } : {}),
    isThisMachine: self === row.enrollment_id,
    enrolled: true,
    enrollment: { hostId: row.host_id, lastSeenAt: row.last_seen_at, servingWorkspaceIds: row.serving_workspace_ids },
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

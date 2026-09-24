import { fetchQuery } from "./fetch-query"
import { machineId } from "./ids"
import { queryKeys } from "./query-keys"
import type { Transport } from "./transport"
import type { FetchQuery, Machine } from "./types"
import type { Workspaces } from "./workspaces"

export const MACHINE_ONLINE_WINDOW_MS = 120_000

type DeviceRow = { readonly host_id: string; readonly display_name: string; readonly last_seen_at: number }

function isDeviceRow(value: unknown): value is DeviceRow {
  const row = value as Partial<DeviceRow> | null
  return !!row && typeof row.host_id === "string" && typeof row.display_name === "string" && typeof row.last_seen_at === "number"
}

export function machineFromDevice(row: DeviceRow, self: string | undefined, now: number): Machine {
  return {
    id: machineId(row.host_id),
    name: row.display_name,
    online: now - row.last_seen_at < MACHINE_ONLINE_WINDOW_MS,
    isThisMachine: self !== undefined && self === row.host_id,
  }
}

export async function listMachines(transport: Transport, workspaces: Workspaces): Promise<readonly Machine[]> {
  const body = await transport.json<{ devices?: unknown }>("/api/claxedo/remote-access/devices")
  const self = workspaces.catalog()?.declaration.enrollmentId
  const now = Date.now()
  return (Array.isArray(body.devices) ? body.devices : []).filter(isDeviceRow).map((row) => machineFromDevice(row, self, now))
}

export function machineQueries(transport: Transport, workspaces: Workspaces) {
  return {
    list: () => fetchQuery<readonly Machine[]>(queryKeys.machines(transport.serverUrl), () => listMachines(transport, workspaces)),
  }
}

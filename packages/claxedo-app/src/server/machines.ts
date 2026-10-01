import { isNonBlankString } from "@claxedo/helpers/guards"
import { readField } from "@claxedo/helpers/readers"
import { fetchQuery } from "./fetch-query"
import { machineId } from "./ids"
import { queryKeys } from "./query-keys"
import type { Transport } from "./transport"
import type { FetchQuery, Machine } from "./types"
import type { Workspaces } from "./workspaces"
import { UNENROLLED_MACHINE, type BootstrapDeclaration } from "./wire/placements"

const MACHINE_ONLINE_WINDOW_MS = 120_000

const DEVICES_PATH = "/api/claxedo/remote-access/devices"

type DeviceRow = { readonly host_id: string; readonly display_name: string; readonly last_seen_at: number }

type MachineReport = () => Promise<unknown>

function isDeviceRow(value: unknown): value is DeviceRow {
  const row = value as Partial<DeviceRow> | null
  return !!row && typeof row.host_id === "string" && typeof row.display_name === "string" && typeof row.last_seen_at === "number"
}

function machineFromDevice(row: DeviceRow, self: string | undefined, now: number): Machine {
  return {
    id: machineId(row.host_id),
    name: row.display_name,
    online: now - row.last_seen_at < MACHINE_ONLINE_WINDOW_MS,
    isThisMachine: self !== undefined && self === row.host_id,
    enrolled: true,
  }
}

export function thisMachineId(declaration: BootstrapDeclaration) {
  return machineId(declaration.enrollmentId ?? UNENROLLED_MACHINE)
}

export function thisMachine(declaration: BootstrapDeclaration, loopback: boolean): Machine | undefined {
  if (!loopback) return undefined
  return { id: thisMachineId(declaration), name: "This machine", online: true, isThisMachine: true, enrolled: declaration.enrollmentId !== undefined }
}

function reportedMachineName(report: unknown): string | undefined {
  const name = readField(report, "displayName")
  return isNonBlankString(name) ? name.trim() : undefined
}

async function namedByReport(machine: Machine, report: MachineReport | undefined): Promise<Machine> {
  const name = report ? reportedMachineName(await report()) : undefined
  return name ? { ...machine, name } : machine
}

async function loadMachines(transport: Transport, workspaces: Workspaces, report: MachineReport | undefined): Promise<readonly Machine[]> {
  const { declaration } = await workspaces.load()
  if (!declaration.issuesSessions) {
    const machine = thisMachine(declaration, transport.loopback)
    return machine ? [await namedByReport(machine, report)] : []
  }
  const body = await transport.json<{ devices?: unknown }>(DEVICES_PATH)
  const now = Date.now()
  return (Array.isArray(body.devices) ? body.devices : []).filter(isDeviceRow).map((row) => machineFromDevice(row, declaration.enrollmentId, now))
}

export function machineQueries(transport: Transport, workspaces: Workspaces, report?: MachineReport) {
  return {
    list: (): FetchQuery<readonly Machine[]> => fetchQuery(queryKeys.machines(transport.serverUrl), () => loadMachines(transport, workspaces, report)),
  }
}

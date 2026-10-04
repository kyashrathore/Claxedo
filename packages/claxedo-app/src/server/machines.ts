import { isNonBlankString, isRecord } from "@claxedo/helpers/guards"
import { readArray, readField } from "@claxedo/helpers/readers"
import type { HostedAccount } from "./account"
import { fetchQuery } from "./fetch-query"
import { machineId } from "./ids"
import { queryKeys } from "./query-keys"
import type { Transport } from "./transport"
import type { FetchQuery, Machine } from "./types"
import type { Workspaces } from "./workspaces"
import { UNENROLLED_MACHINE, type BootstrapDeclaration } from "./wire/placements"

const MACHINE_ONLINE_WINDOW_MS = 120_000

type DeviceRow = { readonly host_id: string; readonly display_name: string; readonly last_seen_at: number }

type MachineReport = () => Promise<unknown>

function isDeviceRow(value: unknown): value is DeviceRow {
  return isRecord(value) && typeof value.host_id === "string" && typeof value.display_name === "string" && typeof value.last_seen_at === "number"
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

async function accountDevices(account: HostedAccount | undefined): Promise<readonly unknown[]> {
  return account ? (readArray(await account.run("machines.list"), "devices") ?? []) : []
}

async function loadMachines(transport: Transport, workspaces: Workspaces, report: MachineReport | undefined, account: HostedAccount | undefined): Promise<readonly Machine[]> {
  const [{ declaration }, devices] = await Promise.all([workspaces.load(), accountDevices(account)])
  const now = Date.now()
  const enrolled = devices.filter(isDeviceRow).map((row) => machineFromDevice(row, declaration.enrollmentId, now))
  const local = thisMachine(declaration, transport.loopback)
  if (!local) return enrolled
  const named = await namedByReport(local, report)
  const listed = enrolled.find((machine) => machine.isThisMachine)
  return listed ? [{ ...listed, online: true }, ...enrolled.filter((machine) => machine !== listed)] : [named, ...enrolled]
}

export function machineQueries(transport: Transport, workspaces: Workspaces, account: HostedAccount | undefined, report?: MachineReport) {
  return {
    list: (): FetchQuery<readonly Machine[]> => fetchQuery(queryKeys.machines(transport.serverUrl), () => loadMachines(transport, workspaces, report, account)),
  }
}

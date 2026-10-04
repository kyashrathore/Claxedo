import { isNonBlankString, isRecord } from "@claxedo/helpers/guards"
import { readArray } from "@claxedo/helpers/readers"
import type { HostedAccount } from "./account"
import { fetchQuery } from "./fetch-query"
import { machineId } from "./ids"
import { queryKeys } from "./query-keys"
import type { Transport } from "./transport"
import type { FetchQuery, Machine } from "./types"
import type { Workspaces } from "./workspaces"
import { servesFromMachine } from "./capabilities"
import type { BootstrapDeclaration } from "./wire/placements"

const MACHINE_ONLINE_WINDOW_MS = 120_000

type DeviceRow = { readonly enrollment_id: string; readonly display_name: string; readonly last_seen_at: number }

function isDeviceRow(value: unknown): value is DeviceRow {
  return isRecord(value) && isNonBlankString(value.enrollment_id) && typeof value.display_name === "string" && typeof value.last_seen_at === "number"
}

function machineFromDevice(row: DeviceRow, self: string | undefined, now: number): Machine {
  return {
    id: machineId(row.enrollment_id),
    name: row.display_name,
    online: now - row.last_seen_at < MACHINE_ONLINE_WINDOW_MS,
    isThisMachine: self === row.enrollment_id,
    enrolled: true,
  }
}

function servingMachine(declaration: BootstrapDeclaration): Machine | undefined {
  if (!declaration.machineName) return undefined
  const enrolled = declaration.enrollmentId !== undefined
  return { ...(declaration.enrollmentId ? { id: machineId(declaration.enrollmentId) } : {}), name: declaration.machineName, online: true, isThisMachine: true, enrolled }
}

async function accountDevices(account: HostedAccount | undefined): Promise<readonly unknown[]> {
  return account ? (readArray(await account.run("machines.list"), "devices") ?? []) : []
}

async function loadMachines(workspaces: Workspaces, account: HostedAccount | undefined): Promise<readonly Machine[]> {
  const [{ declaration }, devices] = await Promise.all([workspaces.load(), accountDevices(account)])
  const now = Date.now()
  const enrolled = devices.filter(isDeviceRow).map((row) => machineFromDevice(row, declaration.enrollmentId, now))
  if (!servesFromMachine(declaration)) return enrolled
  const listed = enrolled.find((machine) => machine.isThisMachine)
  if (listed) return [{ ...listed, online: true }, ...enrolled.filter((machine) => machine !== listed)]
  const serving = servingMachine(declaration)
  return serving ? [serving, ...enrolled] : enrolled
}

export function machineQueries(transport: Transport, workspaces: Workspaces, account: HostedAccount | undefined) {
  return {
    list: (): FetchQuery<readonly Machine[]> => fetchQuery(queryKeys.machines(transport.serverUrl), () => loadMachines(workspaces, account)),
  }
}

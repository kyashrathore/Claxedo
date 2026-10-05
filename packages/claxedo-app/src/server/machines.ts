import { isNonBlankString, isRecord } from "@claxedo/helpers/guards"
import { readArray } from "@claxedo/helpers/readers"
import type { HostedAccount } from "./account"
import { fetchQuery } from "./fetch-query"
import { machineId } from "./ids"
import { queryKeys } from "./query-keys"
import type { Transport } from "./transport"
import type { FetchQuery, Machine } from "./types"
import type { Workspaces } from "./workspaces"
import { servingMachineOf } from "./capabilities"

const DEVICE_STATES: ReadonlySet<unknown> = new Set(["online", "offline", "paused"])

type DeviceRow = { readonly enrollment_id: string; readonly display_name: string; readonly state: "online" | "offline" | "paused" }

function isDeviceRow(value: unknown): value is DeviceRow {
  return isRecord(value) && isNonBlankString(value.enrollment_id) && typeof value.display_name === "string" && DEVICE_STATES.has(value.state)
}

function machineFromDevice(row: DeviceRow, self: string | undefined): Machine {
  return {
    id: machineId(row.enrollment_id),
    name: row.display_name,
    online: row.state === "online",
    ...(row.state === "paused" ? { paused: true } : {}),
    isThisMachine: self === row.enrollment_id,
    enrolled: true,
  }
}

async function accountDevices(account: HostedAccount | undefined): Promise<readonly unknown[]> {
  return account ? (readArray(await account.run("machines.list"), "devices") ?? []) : []
}

async function loadMachines(workspaces: Workspaces, account: HostedAccount | undefined): Promise<readonly Machine[]> {
  const [{ declaration }, devices] = await Promise.all([workspaces.load(), accountDevices(account)])
  const enrolled = devices.filter(isDeviceRow).map((row) => machineFromDevice(row, declaration.enrollmentId))
  const serving = servingMachineOf(declaration)
  if (!serving) return enrolled
  const listed = enrolled.find((machine) => machine.isThisMachine)
  if (listed) return [{ ...listed, online: true }, ...enrolled.filter((machine) => machine !== listed)]
  return [{ ...serving, online: true, isThisMachine: true, enrolled: serving.id !== undefined }, ...enrolled]
}

export function machineQueries(transport: Transport, workspaces: Workspaces, account: HostedAccount | undefined) {
  return {
    list: (): FetchQuery<readonly Machine[]> => fetchQuery(queryKeys.machines(transport.serverUrl), () => loadMachines(workspaces, account)),
  }
}

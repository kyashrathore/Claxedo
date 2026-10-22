import type { QueryClient } from "@tanstack/solid-query"
import { readArray } from "@claxedo/helpers/readers"
import type { HostedAccount } from "./account"
import { ServerError, toAppError } from "./errors"
import { fetchQuery } from "./fetch-query"
import type { Machine, MachineEnrollment, MachineProbe } from "./machine-types"
import { queryKeys } from "./query-keys"
import type { Transport } from "./transport"
import type { FetchQuery } from "./types"
import type { Workspaces } from "./workspaces"
import { servingMachineOf } from "./capabilities"
import { machinesFromDevices, RUNTIME_PROBE_PATH, runtimeProbeFromWire } from "./wire/machines"

export type MachinesApi = {
  readonly recheck: () => Promise<readonly Machine[]>
  readonly pause: (enrollment: MachineEnrollment) => Promise<void>
  readonly resume: (enrollment: MachineEnrollment) => Promise<void>
  readonly remove: (enrollment: MachineEnrollment) => Promise<void>
  readonly probe: (enrollment: MachineEnrollment) => Promise<MachineProbe>
}

async function accountDevices(account: HostedAccount | undefined): Promise<readonly unknown[]> {
  return account ? (readArray(await account.run("machines.list"), "devices") ?? []) : []
}

async function loadMachines(workspaces: Workspaces, account: HostedAccount | undefined): Promise<readonly Machine[]> {
  const [{ declaration }, devices] = await Promise.all([workspaces.load(), accountDevices(account)])
  const enrolled = machinesFromDevices(devices, declaration.enrollmentId)
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

async function probeRuntime(transport: Transport, enrollment: MachineEnrollment): Promise<MachineProbe> {
  const [workspaceId] = enrollment.servingWorkspaceIds
  if (!workspaceId) return { kind: "servesNothing" }
  try {
    return runtimeProbeFromWire(await transport.runtimeJson({ directory: `workspace:${workspaceId}`, workspaceId, remote: true }, RUNTIME_PROBE_PATH))
  } catch (error) {
    return { kind: "unreachable", error: toAppError(error) }
  }
}

export function createMachinesApi(transport: Transport, queryClient: QueryClient, workspaces: Workspaces, account: HostedAccount | undefined): MachinesApi {
  const server = transport.serverUrl
  const change = async (operation: "machines.pause" | "machines.resume" | "machines.remove", enrollment: MachineEnrollment) => {
    if (!account) throw new ServerError({ class: "invalid", message: `${operation} needs a signed-in account` })
    await account.run(operation, { hostId: enrollment.hostId })
    await queryClient.invalidateQueries({ queryKey: queryKeys.machines(server) })
  }
  const recheck = async () => {
    await queryClient.cancelQueries({ queryKey: queryKeys.machines(server) })
    return queryClient.fetchQuery({ ...machineQueries(transport, workspaces, account).list(), staleTime: 0, retry: false, networkMode: "always" })
  }
  return {
    recheck,
    pause: (enrollment) => change("machines.pause", enrollment),
    resume: (enrollment) => change("machines.resume", enrollment),
    remove: async (enrollment) => {
      await change("machines.remove", enrollment)
      await queryClient.invalidateQueries({ queryKey: queryKeys.accountCatalog(server) })
    },
    probe: (enrollment) => probeRuntime(transport, enrollment),
  }
}

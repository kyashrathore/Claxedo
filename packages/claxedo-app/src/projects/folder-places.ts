import { hostPathParent } from "@claxedo/account-contract/host-path"
import type { Machine, MachineId, Placement, ServingMachine } from "@/server"

export type FolderPlace = { readonly machine?: MachineId; readonly name: string; readonly cloneParent?: string }

function servesFolders(machine: Machine): machine is Machine & { readonly id: MachineId } {
  return machine.id !== undefined && machine.enrolled && machine.online && !machine.paused && !machine.isThisMachine
    && (machine.enrollment?.servingWorkspaceIds.length ?? 0) > 0
}

function firstSharedFolderParent(machine: Machine, placements: readonly Placement[]): string | undefined {
  const first = machine.enrollment?.servingWorkspaceIds[0]
  const path = placements.find((placement) => placement.id === first)?.path
  return path === undefined ? undefined : hostPathParent(path)
}

function machinePlace(machine: Machine & { readonly id: MachineId }, placements: readonly Placement[]): FolderPlace {
  const cloneParent = firstSharedFolderParent(machine, placements)
  return { machine: machine.id, name: machine.name, ...(cloneParent ? { cloneParent } : {}) }
}

export function folderPlacesOf(serving: ServingMachine | undefined, machines: readonly Machine[], placements: readonly Placement[]): readonly FolderPlace[] {
  return [
    ...(serving ? [{ name: serving.name }] : []),
    ...machines.filter(servesFolders).map((machine) => machinePlace(machine, placements)),
  ]
}

export function sameFolderPlace(left: FolderPlace, right: FolderPlace): boolean {
  return left.machine === right.machine && left.name === right.name
}

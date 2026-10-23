import type { Machine, MachineId, ServingMachine } from "@/server"

export type FolderPlace = { readonly machine?: MachineId; readonly name: string }

function servesFolders(machine: Machine): machine is Machine & { readonly id: MachineId } {
  return machine.id !== undefined && machine.enrolled && machine.online && !machine.paused && !machine.isThisMachine
    && (machine.enrollment?.servingWorkspaceIds.length ?? 0) > 0
}

export function folderPlacesOf(serving: ServingMachine | undefined, machines: readonly Machine[]): readonly FolderPlace[] {
  return [
    ...(serving ? [{ name: serving.name }] : []),
    ...machines.filter(servesFolders).map((machine) => ({ machine: machine.id, name: machine.name })),
  ]
}

export function sameFolderPlace(left: FolderPlace, right: FolderPlace): boolean {
  return left.machine === right.machine && left.name === right.name
}

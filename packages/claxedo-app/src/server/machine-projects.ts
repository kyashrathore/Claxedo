import { hostPathBasename, normalizeHostPath } from "@claxedo/account-contract/host-path"
import type { HostedAccount } from "./account"
import { ServerError } from "./errors"
import { placementId, type MachineId, type PlacementId } from "./ids"
import type { Machine } from "./machine-types"
import type { Project, ProjectSource } from "./types"
import type { Workspaces } from "./workspaces"

export type MachineFolderSource = Extract<ProjectSource, { readonly kind: "folder" }> & { readonly machine: MachineId }

export type MachineFolderCreate = {
  readonly source: MachineFolderSource
  readonly name?: string
  readonly onPlacement?: (id: PlacementId) => void
}

export function isMachineFolder(source: ProjectSource): source is MachineFolderSource {
  return source.kind === "folder" && source.machine !== undefined
}

function folderNameOf(path: string): string {
  return hostPathBasename(normalizeHostPath(path) ?? path) || path
}

async function machineHostId(machines: () => Promise<readonly Machine[]>, machine: MachineId): Promise<string> {
  const hostId = (await machines()).find((candidate) => candidate.id === machine)?.enrollment?.hostId
  if (!hostId) throw new ServerError({ class: "not_found", message: "That machine is not connected to your account" })
  return hostId
}

export function machineFolderProjectCreator(
  account: HostedAccount | undefined,
  workspaces: Pick<Workspaces, "refresh" | "byId" | "accountProjects">,
  machines: () => Promise<readonly Machine[]>,
) {
  return async (input: MachineFolderCreate): Promise<Project> => {
    if (!account) throw new ServerError({ class: "invalid", message: "A folder on another machine needs a signed-in account" })
    const hostId = await machineHostId(machines, input.source.machine)
    const workspaceId = `ws_${crypto.randomUUID().replaceAll("-", "")}`
    const name = input.name ?? folderNameOf(input.source.path)
    await account.run("machines.assign", { workspaceId, hostId, displayName: name, repoName: name, remoteDirectory: input.source.path })
    await workspaces.refresh()
    const placement = workspaces.byId(placementId(workspaceId))
    const project = placement && (await workspaces.accountProjects()).find((candidate) => candidate.id === placement.projectId)
    if (!placement || !project) throw new ServerError({ class: "internal", message: `The catalog does not list the new workspace ${workspaceId}` })
    input.onPlacement?.(placement.id)
    return project
  }
}

import { hostPathBasename, hostPathJoin, normalizeHostPath } from "@claxedo/account-contract/host-path"
import type { HostedAccount } from "./account"
import { ServerError } from "./errors"
import { placementId, type MachineId, type PlacementId, type ProjectId } from "./ids"
import type { Machine } from "./machine-types"
import { repositoryName } from "./repository-name"
import type { MachineClone, Placement, Project, ProjectSource } from "./types"
import type { Workspaces } from "./workspaces"

type MachineFolderSource = Extract<ProjectSource, { readonly kind: "folder" }> & { readonly machine: MachineId }

type MachineRepositorySource = Exclude<ProjectSource, { readonly kind: "folder" }> & { readonly onMachine: MachineClone }

export type MachineSource = MachineFolderSource | MachineRepositorySource

export type MachineProjectCreate = {
  readonly source: MachineSource
  readonly name?: string
  readonly onPlacement?: (id: PlacementId) => void
}

type MachineCheckout = { readonly directory: string; readonly name: string; readonly repoUrl?: string }

export type MachineAssignment = MachineCheckout & { readonly hostId: string; readonly projectId?: ProjectId; readonly gitBranch?: string }

export type MachinePlacements = Pick<Workspaces, "refresh" | "byId">

export function isMachineSource(source: ProjectSource): source is MachineSource {
  return source.kind === "folder" ? source.machine !== undefined : source.onMachine !== undefined
}

function folderNameOf(path: string): string {
  return hostPathBasename(normalizeHostPath(path) ?? path) || path
}

function machineOf(source: MachineSource): MachineId {
  return source.kind === "folder" ? source.machine : source.onMachine.machine
}

export async function machineHostId(machines: () => Promise<readonly Machine[]>, machine: MachineId): Promise<string> {
  const hostId = (await machines()).find((candidate) => candidate.id === machine)?.enrollment?.hostId
  if (!hostId) throw new ServerError({ class: "not_found", message: "That machine is not connected to your account" })
  return hostId
}

async function cloneOnMachine(account: HostedAccount, source: MachineRepositorySource): Promise<MachineCheckout> {
  const name = repositoryName(source)
  const directory = hostPathJoin(source.onMachine.parent, [name])
  if (!directory) throw new ServerError({ class: "invalid", message: `${source.onMachine.parent} is not a full path on that machine` })
  const repository = source.kind === "repository" ? { repoUrl: source.url } : { connectionId: source.connectionId, repoFullName: source.fullName }
  const cloned = await account.run("machines.clone", { enrollmentId: source.onMachine.machine, directory, ...repository })
  if (typeof cloned.directory !== "string" || typeof cloned.repoUrl !== "string") {
    throw new ServerError({ class: "internal", message: "The machine's clone did not name its folder and repository" })
  }
  return { directory: cloned.directory, name, repoUrl: cloned.repoUrl }
}

function machineCheckout(account: HostedAccount, source: MachineSource): Promise<MachineCheckout> | MachineCheckout {
  return source.kind === "folder" ? { directory: source.path, name: folderNameOf(source.path) } : cloneOnMachine(account, source)
}

export async function assignOnMachine(account: HostedAccount, workspaces: MachinePlacements, assignment: MachineAssignment): Promise<Placement> {
  const workspaceId = `ws_${crypto.randomUUID().replaceAll("-", "")}`
  await account.run("machines.assign", {
    workspaceId,
    hostId: assignment.hostId,
    displayName: assignment.name,
    repoName: assignment.name,
    remoteDirectory: assignment.directory,
    ...(assignment.repoUrl ? { repoUrl: assignment.repoUrl } : {}),
    ...(assignment.projectId ? { projectId: assignment.projectId } : {}),
    ...(assignment.gitBranch ? { gitBranch: assignment.gitBranch } : {}),
  })
  await workspaces.refresh()
  const placement = workspaces.byId(placementId(workspaceId))
  if (!placement) throw new ServerError({ class: "internal", message: `The catalog does not list the new workspace ${workspaceId}` })
  return placement
}

export function machineProjectCreator(
  account: HostedAccount | undefined,
  workspaces: MachinePlacements & Pick<Workspaces, "accountProjects">,
  machines: () => Promise<readonly Machine[]>,
) {
  return async (input: MachineProjectCreate): Promise<Project> => {
    if (!account) throw new ServerError({ class: "invalid", message: "A project on another machine needs a signed-in account" })
    const hostId = await machineHostId(machines, machineOf(input.source))
    const checkout = await machineCheckout(account, input.source)
    const placement = await assignOnMachine(account, workspaces, { ...checkout, hostId, name: input.name ?? checkout.name })
    const project = (await workspaces.accountProjects()).find((candidate) => candidate.id === placement.projectId)
    if (!project) throw new ServerError({ class: "internal", message: `The catalog does not list the project of the new workspace ${placement.id}` })
    input.onPlacement?.(placement.id)
    return project
  }
}

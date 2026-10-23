/// <reference types="bun" />
import { expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import type { CloudSourceCreateInput, CloudWorkspace } from "./cloud-types"
import { ServerError } from "./errors"
import type { HostedAccount } from "./account"
import { machineId, placementId, projectId } from "./ids"
import { machineProjectCreator } from "./machine-projects"
import type { Machine } from "./machine-types"
import { createProjectsApi } from "./projects"
import { queryKeys } from "./query-keys"
import type { Transport } from "./transport"
import type { Project, ProjectSource } from "./types"
import type { Workspaces } from "./workspaces"

const serverUrl = "http://127.0.0.1:4096"
const repository: ProjectSource = { kind: "repository", url: "https://github.com/octocat/Spoon-Knife" }
const accountProject = { id: projectId("prj_account"), name: "octocat/Spoon-Knife", available: true, createdAt: 1, updatedAt: 1 } as Project
const wireProject = { id: "prj_local", name: "Spoon-Knife", available: true, created_at: 1, updated_at: 1 }

const buildBox = {
  id: machineId("enr_box"),
  name: "build-box",
  online: true,
  isThisMachine: false,
  enrolled: true,
  enrollment: { hostId: "host_box", lastSeenAt: 1, servingWorkspaceIds: ["ws_first"] },
} satisfies Machine

function world(serverKind: "daemon" | "hosted") {
  const requests: string[] = []
  const created: CloudSourceCreateInput[] = []
  const assigned: Array<Readonly<Record<string, unknown>>> = []
  const cloned: Array<Readonly<Record<string, unknown>>> = []
  const transport = {
    serverUrl,
    json: async (path: string) => {
      requests.push(path)
      return { project: wireProject }
    },
  } as unknown as Transport
  const workspaces = {
    load: async () => ({ declaration: { serverKind } }),
    catalog: () => ({ declaration: { serverKind } }),
    refresh: async () => {},
    byId: (id: string) => (assigned.some((input) => input.workspaceId === id) ? { id, projectId: accountProject.id } : undefined),
    accountProjects: async () => (created.length > 0 || assigned.length > 0 ? [accountProject] : []),
  } as unknown as Workspaces
  const account = {
    run: async (operation: string, input: Readonly<Record<string, unknown>>) => {
      if (operation === "machines.clone") {
        cloned.push(input)
        return { repoUrl: input.repoUrl ?? `https://github.com/${String(input.repoFullName)}.git`, directory: input.directory }
      }
      if (operation !== "machines.assign") throw new Error(`unexpected ${operation}`)
      assigned.push(input)
      return { assignment: { assigned: true, workspace_id: input.workspaceId, host_id: input.hostId } }
    },
  } as unknown as HostedAccount
  const createCloudWorkspace = async (input: CloudSourceCreateInput): Promise<CloudWorkspace> => {
    created.push(input)
    await input.onCreated?.(placementId("ws_new"))
    return { id: placementId("ws_new"), projectId: accountProject.id } as CloudWorkspace
  }
  const queryClient = new QueryClient()
  const createOnMachine = machineProjectCreator(account, workspaces, async () => [buildBox])
  return { api: createProjectsApi(transport, queryClient, workspaces, createCloudWorkspace, createOnMachine), requests, created, assigned, cloned, queryClient }
}

test("a hosted plane creates a project from a repository URL as that repository's first cloud workspace, named after the repository, and answers the catalog's project", async () => {
  const { api, requests, created, queryClient } = world("hosted")
  const project = await api.create({ source: repository })
  expect(created).toEqual([{ source: repository, name: "Spoon-Knife" }])
  expect(requests).toEqual([])
  expect(project).toBe(accountProject)
  expect(queryClient.getQueryData<Project>(queryKeys.project(serverUrl, accountProject.id))).toBe(accountProject)
})

test("a name typed for the project names its workspace, and a folder cannot be a hosted project", async () => {
  const { api, created } = world("hosted")
  await api.create({ source: repository, name: "Knife" })
  expect(created.map((input) => input.name)).toEqual(["Knife"])
  const refused = api.create({ source: { kind: "folder", path: "/home/me/knife" } })
  await expect(refused).rejects.toBeInstanceOf(ServerError)
  await expect(refused).rejects.toMatchObject({ class: "invalid", code: "project_folder_unavailable" })
  expect(created).toHaveLength(1)
})

test("a daemon creates the project through its own route and never a cloud workspace", async () => {
  const { api, requests, created } = world("daemon")
  const project = await api.create({ source: repository })
  expect(requests).toEqual(["/api/claxedo/projects"])
  expect(created).toEqual([])
  expect(project.id).toBe(projectId("prj_local"))
})

test("a hosted create reports the workspace it just made, so a repository that already has a project opens the new workspace", async () => {
  const { api } = world("hosted")
  const reported: string[] = []
  await api.create({ source: repository, onPlacement: (id) => reported.push(id) })
  expect(reported).toEqual(["ws_new"])
})

test("a folder on a connected machine becomes a new workspace assigned to that machine, on a hosted plane and a daemon alike", async () => {
  for (const serverKind of ["hosted", "daemon"] as const) {
    const { api, requests, created, assigned } = world(serverKind)
    const reported: string[] = []
    const project = await api.create({ source: { kind: "folder", path: "/home/ada/code/alpha/", machine: buildBox.id }, onPlacement: (id) => reported.push(id) })
    expect(project).toBe(accountProject)
    expect(requests).toEqual([])
    expect(created).toEqual([])
    expect(assigned).toEqual([{ workspaceId: expect.stringMatching(/^ws_[0-9a-f]{32}$/), hostId: "host_box", displayName: "alpha", repoName: "alpha", remoteDirectory: "/home/ada/code/alpha/" }])
    expect(reported).toEqual([String(assigned[0]?.workspaceId)])
  }
})

test("a folder on a machine that is not the account's is refused before anything is assigned", async () => {
  const { api, assigned, cloned } = world("hosted")
  await expect(api.create({ source: { kind: "folder", path: "/srv/app", machine: machineId("enr_other") } })).rejects.toMatchObject({ class: "not_found" })
  await expect(api.create({ source: { ...repository, onMachine: { machine: machineId("enr_other"), parent: "/srv" } } })).rejects.toMatchObject({ class: "not_found" })
  expect(assigned).toEqual([])
  expect(cloned).toEqual([])
})

test("a repository cloned onto a connected machine lands in a folder named for it under the chosen one, and that folder is assigned with its remote", async () => {
  const { api, created, cloned, assigned } = world("hosted")
  const onMachine = { machine: buildBox.id, parent: "/home/ada/code" }
  await api.create({ source: { ...repository, onMachine } })
  await api.create({ source: { kind: "connectedRepository", connectionId: "conn_gh", fullName: "acme/private", onMachine }, name: "Private" })
  expect(created).toEqual([])
  expect(cloned).toEqual([
    { enrollmentId: "enr_box", directory: "/home/ada/code/Spoon-Knife", repoUrl: repository.url },
    { enrollmentId: "enr_box", directory: "/home/ada/code/private", connectionId: "conn_gh", repoFullName: "acme/private" },
  ])
  expect(assigned.map(({ workspaceId: _id, ...rest }) => rest)).toEqual([
    { hostId: "host_box", displayName: "Spoon-Knife", repoName: "Spoon-Knife", remoteDirectory: "/home/ada/code/Spoon-Knife", repoUrl: repository.url },
    { hostId: "host_box", displayName: "Private", repoName: "Private", remoteDirectory: "/home/ada/code/private", repoUrl: "https://github.com/acme/private.git" },
  ])
})

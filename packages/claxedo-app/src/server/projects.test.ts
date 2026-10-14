/// <reference types="bun" />
import { expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import type { CloudSourceCreateInput, CloudWorkspace } from "./cloud-types"
import { ServerError } from "./errors"
import { placementId, projectId } from "./ids"
import { createProjectsApi } from "./projects"
import { queryKeys } from "./query-keys"
import type { Transport } from "./transport"
import type { Project, ProjectSource } from "./types"
import type { Workspaces } from "./workspaces"

const serverUrl = "http://127.0.0.1:4096"
const repository: ProjectSource = { kind: "repository", url: "https://github.com/octocat/Spoon-Knife" }
const accountProject = { id: projectId("prj_account"), name: "octocat/Spoon-Knife", available: true, createdAt: 1, updatedAt: 1 } as Project
const wireProject = { id: "prj_local", name: "Spoon-Knife", available: true, created_at: 1, updated_at: 1 }

function world(serverKind: "daemon" | "hosted") {
  const requests: string[] = []
  const created: CloudSourceCreateInput[] = []
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
    accountProjects: async () => (created.length > 0 ? [accountProject] : []),
  } as unknown as Workspaces
  const createCloudWorkspace = async (input: CloudSourceCreateInput): Promise<CloudWorkspace> => {
    created.push(input)
    return { id: placementId("ws_new"), projectId: accountProject.id } as CloudWorkspace
  }
  const queryClient = new QueryClient()
  return { api: createProjectsApi(transport, queryClient, workspaces, createCloudWorkspace), requests, created, queryClient }
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

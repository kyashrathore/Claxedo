/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, projectId, ServerError, type CloudCreateInput, type PlacementId, type Project, type ProjectId, type ProjectSource, type Server } from "@/server"
import type { OnboardingText } from "./i18n"
import type { Created } from "./model"
import { createOnboardingTarget, finishFailure, openedPlacement } from "./place"

const t = ((key: string, params?: Readonly<Record<string, string>>) => (params ? `${key} ${JSON.stringify(params)}` : key)) as OnboardingText
const repository: ProjectSource = { kind: "repository", url: "https://github.com/acme/widgets" }
const created = { id: projectId("prj_1"), name: "widgets" } as Pick<Project, "id" | "name"> as Project

function fakeServer() {
  const calls: Array<{ readonly call: string; readonly input: unknown }> = []
  const server = {
    projects: {
      create: async (input: unknown) => (calls.push({ call: "projects.create", input }), created),
    },
    cloud: {
      create: async (input: CloudCreateInput) => (calls.push({ call: "cloud.create", input }), { id: placementId("ws_created") }),
    },
  } as unknown as Server
  return { server, calls }
}

test("a signed desktop that picked the cloud creates a cloud workspace from the repository, not a local project", async () => {
  const { server, calls } = fakeServer()
  const target = await createOnboardingTarget(server, t, { draft: { source: repository, name: "Widgets" }, choice: "cloud", localExecution: true }, undefined)
  expect(target).toEqual({ kind: "workspace", placementId: placementId("ws_created") })
  expect(calls).toEqual([{ call: "cloud.create", input: { source: repository, name: "Widgets" } }])
})

test("a desktop that keeps this machine creates the project; a cloud choice never takes a local folder", async () => {
  const { server, calls } = fakeServer()
  const folder: ProjectSource = { kind: "folder", path: "/home/me/widgets" }
  expect(await createOnboardingTarget(server, t, { draft: { source: folder }, choice: "local", localExecution: true }, undefined)).toEqual({ kind: "project", project: created })
  const refused = createOnboardingTarget(server, t, { draft: { source: folder }, choice: "cloud", localExecution: true }, undefined)
  await expect(refused).rejects.toBeInstanceOf(ServerError)
  await expect(refused).rejects.toThrow("onboarding.reason.execution.folder")
  expect(calls).toEqual([{ call: "projects.create", input: { source: folder } }])
})

test("a hosted plane creates the project first, then the remembered project's workspace", async () => {
  const { server, calls } = fakeServer()
  const placing = { draft: { source: repository }, choice: "cloud", localExecution: false } as const
  const project = await createOnboardingTarget(server, t, placing, undefined)
  expect(project).toEqual({ kind: "cloudProject", project: created })
  expect(await createOnboardingTarget(server, t, placing, project)).toEqual({ kind: "workspace", placementId: placementId("ws_created") })
  expect(calls).toEqual([
    { call: "projects.create", input: { source: repository } },
    { call: "cloud.create", input: { projectId: created.id } },
  ])
})

test("opening picks the created placement, and a project with no placement here is a failure after creation", () => {
  const workspace: Created = { kind: "workspace", placementId: placementId("ws_created") }
  const project: Created = { kind: "project", project: created }
  const lookups: string[] = []
  const placementOf = (known: PlacementId | undefined) => (id: ProjectId) => (lookups.push(String(id)), known)
  expect(openedPlacement(t, workspace, placementOf(undefined))).toBe(placementId("ws_created"))
  expect(openedPlacement(t, project, placementOf(placementId("pl_folder")))).toBe(placementId("pl_folder"))
  let failure: unknown
  try {
    openedPlacement(t, project, placementOf(undefined))
  } catch (error) {
    failure = error
  }
  expect(lookups).toEqual(["prj_1", "prj_1"])
  expect(finishFailure(t, failure, project)).toBe(`onboarding.failed.open ${JSON.stringify({ error: 'onboarding.failed.noPlacement {"project":"widgets"}' })}`)
  expect(finishFailure(t, new Error("Workspace creation refused"), undefined)).toBe("Workspace creation refused")
})

/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, projectId, ServerError, type CloudCreateInput, type PlacementId, type Project, type ProjectId, type ProjectSource, type Server } from "@/server"
import type { OnboardingText } from "./i18n"
import type { Created } from "./model"
import { createOnboardingTarget, finishFailure, openedPlacement, openingDetail, startCreated } from "./place"

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
      start: async (id: PlacementId) => {
        calls.push({ call: "cloud.start", input: id })
      },
      create: async ({ onCreated, ...input }: CloudCreateInput & { onCreated?: (id: PlacementId) => void }) => {
        calls.push({ call: "cloud.create", input })
        onCreated?.(placementId("ws_created"))
        return { id: placementId("ws_created") }
      },
    },
  } as unknown as Server
  return { server, calls }
}

test("a signed desktop that picked the cloud creates a cloud workspace named by the person, not a local project or the project's name", async () => {
  const { server, calls } = fakeServer()
  const held: Created[] = []
  const target = await createOnboardingTarget(server, t, { draft: { source: repository, name: "Widgets" }, plan: { kind: "cloud", name: "Payments" } }, (created) => held.push(created))
  expect(target).toEqual({ kind: "workspace", placementId: placementId("ws_created") })
  expect(held).toEqual([target])
  expect(calls).toEqual([{ call: "cloud.create", input: { source: repository, name: "Payments" } }])
})

test("a desktop that keeps this machine creates the project; a cloud choice never takes a local folder", async () => {
  const { server, calls } = fakeServer()
  const folder: ProjectSource = { kind: "folder", path: "/home/me/widgets" }
  expect(await createOnboardingTarget(server, t, { draft: { source: folder }, plan: { kind: "local" } }, () => {})).toEqual({ kind: "project", project: created })
  const refused = createOnboardingTarget(server, t, { draft: { source: folder }, plan: { kind: "cloud", name: "Widgets" } }, () => {})
  await expect(refused).rejects.toBeInstanceOf(ServerError)
  await expect(refused).rejects.toThrow("onboarding.reason.execution.folder")
  expect(calls).toEqual([{ call: "projects.create", input: { source: folder } }])
})

test("a hosted plane creates the cloud workspace from the connected repository in one signed-account call", async () => {
  const { server, calls } = fakeServer()
  const source: ProjectSource = { kind: "connectedRepository", connectionId: "gh_1", fullName: "acme/widgets" }
  expect(await createOnboardingTarget(server, t, { draft: { source }, plan: { kind: "cloud", name: "Widgets" } }, () => {})).toEqual({ kind: "workspace", placementId: placementId("ws_created") })
  expect(calls).toEqual([{ call: "cloud.create", input: { source, name: "Widgets" } }])
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

test("a created cloud workspace is started before it opens, so its first screen is live; a project opens as it is", async () => {
  const { server, calls } = fakeServer()
  await startCreated(server, { kind: "project", project: created })
  expect(calls).toEqual([])
  await startCreated(server, { kind: "workspace", placementId: placementId("ws_created") })
  expect(calls).toEqual([{ call: "cloud.start", input: placementId("ws_created") }])
})

test("the opening detail names the boot a waking workspace is on, and nothing once it is live or failed", () => {
  expect(openingDetail(t, { kind: "waking" })).toBe("onboarding.opening.starting")
  expect(openingDetail(t, { kind: "waking", bootMode: "cold-start" })).toBe("onboarding.opening.starting")
  expect(openingDetail(t, { kind: "waking", bootMode: "resume" })).toBe("onboarding.opening.resuming")
  expect(openingDetail(t, { kind: "waking", bootMode: "restore" })).toBe("onboarding.opening.restoring")
  expect(openingDetail(t, { kind: "live" })).toBeUndefined()
  expect(openingDetail(t, { kind: "wakeFailed", error: { class: "network", retryable: true, message: "offline" } })).toBeUndefined()
})

import { cloudWorkspaces, expect, makeCloudWorkspace, test, UI } from "../harness"
import { pluginSurface, signedTasksClient } from "../harness/tasks"

const REFUSAL = "Plugin composio is not installed from claxedo for this project; turn it on in Settings → Plugins"
const CLAUDE = { harness: { id: "claude", access: "native" as const }, model: { providerID: "claude", modelID: "default" }, effort: null }

test("63 Tasks: a cloud preset naming a plugin nobody turned on is refused at Start in the task's own page, naming the fix, and creates no workspace", async ({ signedCloud, page, isMobile }) => {
  test.setTimeout(120_000)
  const project = await makeCloudWorkspace(signedCloud, "main")
  const tasks = signedTasksClient(signedCloud)
  const presetResponse = await tasks.command({
    clientRequestId: crypto.randomUUID(),
    command: {
      type: "preset.create",
      input: {
        name: "With Composio",
        instructions: "",
        execution: { placement: "cloud", capabilities: { mode: "selected", plugins: [{ sourceId: "claxedo", pluginName: "composio" }], skills: [] } },
        configurations: { primary: CLAUDE },
        agentStartable: false,
      },
    },
  })
  const preset = presetResponse.result
  if (preset.type !== "preset.create") throw new Error("the preset was not created")
  const createdResponse = await tasks.command({
    clientRequestId: crypto.randomUUID(),
    command: { type: "task.create", input: { projectId: project.projectId, title: "Connect the apps", description: "", workspaceId: null, parentTaskId: null } },
  })
  const created = createdResponse.result
  if (created.type !== "task.create") throw new Error("the task was not created")
  const before = (await cloudWorkspaces(signedCloud)).length

  const previewed = await tasks.startPreview(created.task.id, {
    taskRevision: created.task.revision, presetId: preset.preset.id, presetRevision: preset.preset.revision, slot: "primary", attempt: 1, continueFromPrevious: false,
  })
  expect(previewed.preview.available).toBe(false)
  expect(previewed.preview.blockers).toEqual([{ code: "capability_unavailable", detail: REFUSAL }])

  await signedCloud.signIn(page, signedCloud.owner)
  const rail = page.getByRole("navigation", { name: UI.rail })
  if (isMobile) await page.getByRole("button", { name: UI.openRail }).tap()
  await rail.getByRole("button", { name: "Tasks", exact: true }).click()
  const surface = pluginSurface(page)
  await surface.locator('[data-slot="surface-list-item"], [role="listitem"]').filter({ hasText: "Connect the apps" }).getByRole("button", { name: "Open", exact: true }).click()
  await surface.getByRole("region", { name: "Sessions" }).getByRole("button", { name: "Start", exact: true }).click()
  await expect(surface.getByText(REFUSAL, { exact: true })).toBeVisible()

  expect((await cloudWorkspaces(signedCloud)).length, "the refused Start created no cloud root").toBe(before)
})

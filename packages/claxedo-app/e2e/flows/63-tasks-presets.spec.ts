import { chooseHarnessAndModel, pluginSurface, PRESETS_SETTINGS_PATH, tasksClient } from "../harness/tasks"
import { expect, test } from "../harness"

test("63 Settings → Presets: create a local preset with the agent picker, edit it, archive and restore it, and a cloud preset refuses Pi", async ({ stack, app }) => {
  await stack.daemon.makeWorkspace("presets", "Presets project")
  await app.goto(`${stack.url}${PRESETS_SETTINGS_PATH}`)
  const surface = pluginSurface(app)
  await expect(surface.locator('[data-slot="surface-source"]')).toHaveText("Tasks · app plugin")
  await expect(surface.getByText("No presets yet", { exact: true })).toBeVisible()

  await surface.getByRole("button", { name: "New preset" }).click()
  await surface.getByRole("textbox", { name: "Name" }).fill("Careful reviewer")
  await chooseHarnessAndModel(app, surface.locator('[data-slot="surface-section"]').filter({ hasText: "Primary" }).first(), "Pi", "GPT-4.1")
  await surface.getByRole("button", { name: "Create preset" }).click()
  const rows = surface.locator('[data-slot="surface-list-item"]')
  await expect(rows.filter({ hasText: "Careful reviewer" })).toContainText("Local · Pi · openai/gpt-4.1")
  const saved = (await tasksClient(stack.url).listPresets()).items
  expect(saved.map((preset) => [preset.name, preset.execution.placement, preset.configurations.primary.harness.id])).toEqual([["Careful reviewer", "local", "pi"]])

  await rows.filter({ hasText: "Careful reviewer" }).getByRole("button", { name: "Edit" }).click()
  await surface.getByRole("textbox", { name: "Name" }).fill("Careful reviewer, edited")
  await surface.getByRole("button", { name: "Save preset" }).click()
  await expect(rows.filter({ hasText: "Careful reviewer, edited" })).toContainText("Local · Pi · openai/gpt-4.1")
  expect((await tasksClient(stack.url).listPresets()).items.map((preset) => preset.configurations.primary.model)).toEqual([{ providerID: "pi", modelID: "openai/gpt-4.1" }])

  await rows.filter({ hasText: "Careful reviewer, edited" }).getByRole("button", { name: "Archive Careful reviewer, edited" }).click({ force: true })
  await expect(surface.getByText("No presets yet", { exact: true })).toBeVisible()
  await surface.getByText("Show archived presets", { exact: true }).click()
  await expect(rows.filter({ hasText: "Careful reviewer, edited" })).toContainText("Archived")
  await rows.filter({ hasText: "Careful reviewer, edited" }).getByRole("button", { name: "Restore Careful reviewer, edited" }).click({ force: true })
  await expect(rows.filter({ hasText: "Careful reviewer, edited" })).not.toContainText("Archived")

  await surface.getByRole("button", { name: "New preset" }).click()
  await surface.getByRole("button", { name: "Cloud", exact: true }).click()
  await expect(surface.getByText("This server does not run Cloud presets", { exact: true })).toBeVisible()
  await surface.getByRole("button", { name: /^Harness / }).click()
  await app.getByRole("option", { name: "Codex", exact: true }).click()
  await expect(surface.getByText("Pi cannot run a cloud preset", { exact: true })).toHaveCount(0)
  await surface.getByRole("button", { name: /^Harness / }).click()
  await app.getByRole("option", { name: "Pi", exact: true }).click()
  await expect(surface.getByText("Pi cannot run a cloud preset", { exact: true })).toBeVisible()
  await expect(surface.getByText(/^Pi runs in its own session host on a cloud workspace/)).toBeVisible()
})

test("63 Settings → Presets: a saved preset opens in the editor with its own agent configuration and saves it unchanged", async ({ stack, app }) => {
  await stack.daemon.makeWorkspace("presets", "Presets project")
  const primary = { harness: { id: "pi", access: "native" as const }, model: { providerID: "pi", modelID: "openai/gpt-4.1" }, effort: null }
  await tasksClient(stack.url).command({
    clientRequestId: crypto.randomUUID(),
    command: { type: "preset.create", input: { name: "Seeded reviewer", instructions: "", execution: { placement: "local", capabilities: { mode: "inherit-local" } }, configurations: { primary }, agentStartable: false } },
  })
  await app.goto(`${stack.url}${PRESETS_SETTINGS_PATH}`)
  const surface = pluginSurface(app)
  const rows = surface.locator('[data-slot="surface-list-item"]')
  await rows.filter({ hasText: "Seeded reviewer" }).getByRole("button", { name: "Edit" }).click()
  await expect(surface.getByRole("button", { name: /^Select harness and model/ })).toContainText("GPT-4.1")
  await surface.getByRole("textbox", { name: "Name" }).fill("Seeded reviewer, renamed")
  await surface.getByRole("button", { name: "Save preset" }).click()
  await expect(rows.filter({ hasText: "Seeded reviewer, renamed" })).toContainText("Local · Pi · openai/gpt-4.1")
  expect((await tasksClient(stack.url).listPresets()).items.map((preset) => preset.configurations.primary)).toEqual([primary])
})

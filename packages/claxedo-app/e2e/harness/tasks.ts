import type { Locator, Page } from "@playwright/test"
import { TASKS_ROUTE_PATH } from "@claxedo/tasks"
import { createTasksClient, type TasksClient } from "@claxedo/tasks/client"
import { expect } from "./fixtures"
import { showHarnesses } from "./composer"

export const PRESETS_SETTINGS_PATH = `/settings/${encodeURIComponent("claxedo-tasks/presets")}`

export function tasksClient(serverUrl: string): TasksClient {
  return createTasksClient({ baseUrl: new URL(TASKS_ROUTE_PATH, serverUrl).href, request: (url, init) => fetch(url, init) })
}

export function pluginSurface(app: Page): Locator {
  return app.locator('[data-component="surface"][data-source="plugin"]')
}

export async function chooseHarnessAndModel(app: Page, scope: Locator, harness: string, model: string) {
  await scope.getByRole("button", { name: /^Select harness and model/ }).click()
  const picker = app.getByRole("dialog", { name: "Select harness, model and effort" })
  await showHarnesses(picker)
  await picker.getByRole("button", { name: harness, exact: true }).click()
  await picker.getByRole("button", { name: model, exact: true }).click()
  await app.keyboard.press("Escape")
  await expect(picker).toHaveCount(0)
}

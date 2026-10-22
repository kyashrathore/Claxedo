import type { Locator, Page } from "@playwright/test"
import { TASKS_ROUTE_PATH } from "@claxedo/tasks"
import { createTasksClient, type TasksClient } from "@claxedo/tasks/client"
import { expect } from "./fixtures"
import type { SignedStack } from "./signed-stack"
import { showHarnesses } from "./composer"

export const PRESETS_SETTINGS_PATH = `/settings/${encodeURIComponent("claxedo-tasks/presets")}`

export function tasksClient(serverUrl: string): TasksClient {
  return createTasksClient({ baseUrl: new URL(TASKS_ROUTE_PATH, serverUrl).href, request: (url, init) => fetch(url, init) })
}

export function signedTasksClient(signed: SignedStack): TasksClient {
  return createTasksClient({
    baseUrl: new URL(TASKS_ROUTE_PATH, signed.hosted.workerUrl).href,
    request: async (url, init) => {
      const reply = await signed.owner.transport({
        method: init?.method ?? "GET",
        url,
        headers: { "content-type": "application/json" },
        body: typeof init?.body === "string" ? init.body : undefined,
      })
      return new Response(reply.body, { status: reply.status, headers: { "content-type": "application/json" } })
    },
  })
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

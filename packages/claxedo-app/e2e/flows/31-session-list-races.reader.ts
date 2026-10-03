import type { Page } from "@playwright/test"
import { expect, type Stack } from "../harness"
import { readerPage } from "../harness/session-reader"

export { readerPage, readerRow, writeReader } from "../harness/session-reader"

export function activityRow(app: Page, title: string) {
  return app.getByTestId("activity-session-row").filter({ has: app.getByRole("button", { name: title, exact: true }) })
}


export async function expectInventoryMatchesServer(app: Page, stack: Stack, sessionIds: readonly string[]) {
  await expect.poll(async () => {
    const page = await readerPage(stack, { settled: "active" })
    const expected = page.items.filter((row) => sessionIds.includes(row.sessionId)).map((row) => row.sessionId)
    const shown = await app.getByTestId("activity-session-row").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-session-id")))
    return JSON.stringify(expected) === JSON.stringify(shown.filter((id): id is string => id !== null && sessionIds.includes(id)))
  }, { message: "the flat Activity list follows canonical active inventory order" }).toBe(true)
}

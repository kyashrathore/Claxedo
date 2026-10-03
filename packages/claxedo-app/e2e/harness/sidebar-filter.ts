import { expect, type Page } from "@playwright/test"

async function openSidebarOptions(app: Page, phone: boolean): Promise<void> {
  const trigger = app.getByRole("button", { name: "Session options", exact: true })
  if (phone) await trigger.tap()
  else await trigger.click()
}

export async function sidebarFilter(app: Page, choice: "Projects" | "Activity", phone = false): Promise<void> {
  const option = app.getByRole("menuitemradio", { name: choice, exact: true })
  await openSidebarOptions(app, phone)
  if (phone) {
    await option.tap()
  } else {
    await option.click()
  }
}

export async function sidebarHideWorkingStatuses(app: Page, hide: boolean, phone = false): Promise<void> {
  await openSidebarOptions(app, phone)
  const option = app.getByRole("menuitemcheckbox", { name: "Hide working statuses", exact: true })
  if ((await option.isChecked()) !== hide) {
    if (phone) await option.tap()
    else await option.click()
  }
  await expect(option).toHaveAttribute("aria-checked", String(hide))
  if (phone) expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await option.press("Escape")
}

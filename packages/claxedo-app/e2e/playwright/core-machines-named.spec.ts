/**
 * One machine, one name, on every device the account reaches.
 *
 * Facts this spec leans on that are not visible at the call site:
 *   - A machine names itself. `machineDisplayName` is the one derivation, and
 *     Electron main runs it against this computer and sends the result at
 *     enrollment; nothing in the app invents a name, which is why the enable
 *     POST below carries none. The fixture below runs the same function on the
 *     inputs a Mac would give it, so what the fleet lists here is what a
 *     desktop would really have enrolled under.
 *   - The panel reads the account's machines from
 *     `GET /api/claxedo/remote-access/devices`, so what one client renames
 *     the next client reads. The two pages here share one store on purpose:
 *     that store IS the control plane both are talking to.
 *   - `remoteAccessAvailability()` needs `device_login_configured`,
 *     `relay_configured` and `hosted_signed_in` all true before the panel
 *     leaves its locked and sign-in states, which is what makes the fixture
 *     below desktop-shaped rather than merely signed.
 */
// Source, not the package specifier: Playwright resolves with Node conditions
// and would take the published `dist` entry, which a source checkout has not built.
import { machineDisplayName } from "../../../claxedo-helpers/src/machine-name"
import { expect, test, type Page, type Route } from "@playwright/test"
import { installMockRuntime } from "../helpers/mock-runtime"
import { stampTestAuth } from "../playwright-global-setup"

const DIR = "/tmp/e2e-core-machines-named"
const SESSION_ID = "ses_machines_named"
const PROJECT_ID = "proj_machines_named"
const DESKTOP_NAME = machineDisplayName("darwin", {
  computerName: () => "Yashvardhans-MacBook-Pro.local",
  accountName: () => "Yashvardhan Singh",
})
const CONNECT_HOST_NAME = "build-box"

type Machine = {
  host_id: string
  display_name: string
  last_seen_at: number
  workspace_ids: string[]
}

/**
 * The machines half of the control plane: the fleet, and the one write that
 * changes a machine's name. Held in a closure so two pages read one account.
 */
function machineStore(initial: Machine[]) {
  const machines = [...initial]
  const renames: Array<{ hostId: string; displayName: string }> = []

  return {
    machines,
    renames,
    add(machine: Machine) {
      machines.push(machine)
    },
    async handle(route: Route) {
      const request = route.request()
      const url = new URL(request.url())
      const json = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })

      if (url.pathname === "/api/claxedo/remote-access") {
        return json({
          device_login_configured: true,
          relay_configured: true,
          hosted_signed_in: true,
          enabled: true,
          enrolled: true,
          second_device_open: false,
        })
      }
      if (url.pathname === "/api/claxedo/remote-access/devices") return json({ devices: machines })
      const rename = /^\/api\/claxedo\/remote-access\/devices\/([^/]+)$/.exec(url.pathname)
      if (rename && request.method() === "PATCH") {
        const hostId = decodeURIComponent(rename[1] ?? "")
        const body = (request.postDataJSON?.() ?? {}) as Record<string, unknown>
        const displayName = typeof body.display_name === "string" ? body.display_name : ""
        const machine = machines.find((entry) => entry.host_id === hostId)
        if (!machine || !displayName) {
          return json({ error: { code: "host_enrollment_not_found", message: "That machine is not enrolled" } }, 404)
        }
        renames.push({ hostId, displayName })
        machine.display_name = displayName
        return json({ display_name: displayName })
      }
      return route.fallback()
    },
  }
}

/** One client of the account, opened on the Machines panel. */
async function openMachines(page: Page, store: ReturnType<typeof machineStore>) {
  await stampTestAuth(page.context())
  await installMockRuntime(page, {
    dir: DIR,
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    projectName: "machines-named",
  })
  // Registered AFTER the shared mock: it carries its own remote-access stub,
  // and Playwright runs the last-registered matching handler first, so an
  // earlier route here would never be reached.
  await page.route("**/api/claxedo/remote-access**", (route) => void store.handle(route))
  // The per-machine provider configuration the same panel lists; no owner has
  // pushed any.
  await page.route("**/api/claxedo/host/enrollments**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ machines: [] }) }))
  await page.route("**/api/control/orgs**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }))
  await page.goto("/s/new", { waitUntil: "domcontentloaded", timeout: 90_000 })
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await openMachinesPanel(page)
}

/** Settings is a surface on a route; its sections are the rail's own rows. */
async function openMachinesPanel(page: Page) {
  await page.getByTestId("rail-account-trigger").click()
  await page.getByRole("menuitem", { name: /settings/i }).click()
  await page.locator('[data-component="settings-nav-item"][data-section="devices"]').click()
  await expect(page.getByRole("heading", { name: "Machines", level: 1 })).toBeVisible({ timeout: 30_000 })
}

/**
 * The row a machine occupies, found by the one control that names it. The
 * control sits in the row's `role="group"`, whose parent is the row.
 */
function machineRow(page: Page, displayName: string) {
  return page.getByRole("button", { name: `Revoke ${displayName}` }).locator('xpath=ancestor::div[@role="group"]/..')
}

function desktop(): Machine {
  return {
    host_id: "host_desktop",
    display_name: DESKTOP_NAME,
    last_seen_at: Date.now(),
    workspace_ids: ["ws_one", "ws_two"],
  }
}

test.describe("core machines are named @core @surface-web", () => {
  test("a serving machine is listed under the name it derived, with the workspaces it serves", async ({ page }) => {
    test.setTimeout(120_000)
    const store = machineStore([desktop()])
    await openMachines(page, store)

    // The possessive macOS squashes out of its own default name is restored,
    // so this is a derivation and not a string this spec chose.
    expect(DESKTOP_NAME).toBe("Yashvardhan's MacBook Pro")
    const row = machineRow(page, DESKTOP_NAME)
    await expect(row).toContainText(DESKTOP_NAME)
    await expect(row).toContainText("2 workspaces")
  })

  test("a second client of the same account shows the same machine and the same workspaces", async ({ page, context }) => {
    test.setTimeout(120_000)
    const store = machineStore([desktop()])
    await openMachines(page, store)
    await expect(page.getByText(DESKTOP_NAME).first()).toBeVisible()

    const second = await context.newPage()
    await openMachines(second, store)
    await expect(second.getByText(DESKTOP_NAME).first()).toBeVisible()
    await expect(machineRow(second, DESKTOP_NAME)).toContainText("2 workspaces")
    await second.close()
  })

  test("a rename on one client reaches the control plane and is what the next client reads", async ({ page, context }) => {
    test.setTimeout(120_000)
    const store = machineStore([desktop()])
    await openMachines(page, store)

    await page.getByRole("button", { name: `Rename ${DESKTOP_NAME}` }).click()
    const field = page.getByRole("textbox", { name: `Name for ${DESKTOP_NAME}` })
    await field.fill("Studio Mac")
    await field.press("Enter")

    await expect.poll(() => store.renames).toEqual([{ hostId: "host_desktop", displayName: "Studio Mac" }])
    await expect(page.getByText("Studio Mac").first()).toBeVisible()

    const second = await context.newPage()
    await openMachines(second, store)
    await expect(second.getByText("Studio Mac").first()).toBeVisible()
    await expect(second.getByText(DESKTOP_NAME)).toHaveCount(0)
    await second.close()
  })

  test("a machine added with claxedo connect is listed under its own name, beside the panel's one-liner", async ({ page }) => {
    test.setTimeout(120_000)
    const store = machineStore([desktop()])
    await openMachines(page, store)

    // The account already has a machine, so the instructions fold behind one
    // line until asked for.
    await page.locator('[data-action="add-machine"]').click()
    await expect(page.locator('[data-slot="add-connect-host"]')).toContainText("claxedo connect")

    store.add({
      host_id: "host_build",
      display_name: CONNECT_HOST_NAME,
      last_seen_at: Date.now(),
      workspace_ids: ["ws_api"],
    })
    // The panel re-reads the fleet on every open, so reopening it is what a
    // user does after the enrollment lands on the other machine.
    await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await openMachinesPanel(page)

    await expect(machineRow(page, CONNECT_HOST_NAME)).toContainText(CONNECT_HOST_NAME, { timeout: 30_000 })
    await expect(machineRow(page, CONNECT_HOST_NAME)).toContainText("1 workspace")
    await expect(machineRow(page, DESKTOP_NAME)).toContainText(DESKTOP_NAME)
  })
})

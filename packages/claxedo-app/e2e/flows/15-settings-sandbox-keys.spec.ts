import { expect, test } from "../harness"

type SandboxListing = { readonly default_driver: string | null; readonly keys: ReadonlyArray<{ readonly provider_id: string; readonly owner: string | null }> }

async function sandboxListing(url: string): Promise<SandboxListing> {
  const response = await fetch(new URL("/api/claxedo/credentials/sandbox-drivers", url))
  expect(response.status).toBe(200)
  return await response.json() as SandboxListing
}

test("15 settings: the machine's operator adds a sandbox provider key, sees it in use, and removes it", async ({ stack, app, isMobile }) => {
  await app.goto(`${stack.url}/settings/models`)
  const sandbox = app.getByRole("group", { name: "Sandbox", exact: true })
  await expect(sandbox.getByText("No sandbox keys yet.", { exact: true })).toBeVisible()
  await expect(sandbox.getByText("None yet", { exact: true })).toBeVisible()

  await sandbox.getByRole("button", { name: "Add a key", exact: true }).click()
  const form = sandbox.getByRole("form", { name: "Add a key" })
  await form.getByRole("textbox", { name: "Token ID", exact: true }).fill("modal-token-id")
  await form.getByLabel("Token Secret", { exact: true }).fill("modal-token-secret")
  await form.getByRole("button", { name: "Save key", exact: true }).click()

  await expect(form).toHaveCount(0)
  await expect(sandbox.getByText(/^Couldn't check/)).toBeVisible()
  await expect(sandbox.getByRole("group", { name: "Default provider" }).getByRole("button", { name: "Modal", exact: true })).toBeVisible()
  expect(await sandboxListing(stack.url)).toMatchObject({ default_driver: "modal", keys: [{ provider_id: "modal", owner: "local" }] })
  expect(await app.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  const remove = sandbox.getByRole("button", { name: "Remove key", exact: true })
  if (isMobile) {
    const box = await remove.boundingBox()
    expect(box?.height).toBeGreaterThanOrEqual(44)
    expect(box?.width).toBeGreaterThanOrEqual(44)
  }
  await remove.click()
  await sandbox.getByRole("button", { name: "Remove key", exact: true }).click()
  await expect(sandbox.getByText("No sandbox keys yet.", { exact: true })).toBeVisible()
  expect(await sandboxListing(stack.url)).toMatchObject({ default_driver: null, keys: [] })
})

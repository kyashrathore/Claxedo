import { expect, test, type SignedStack } from "../harness"
import { hostedFetch } from "../../../harness/e2e/harness/hosted-auth"
import { HOSTED_SANDBOX_TEST_TOKEN } from "../../../harness/e2e/harness/hosted-stack"

type SandboxListing = { readonly default_driver: string | null; readonly keys: ReadonlyArray<{ readonly provider_id: string }> }

async function sandboxListing(signed: SignedStack): Promise<SandboxListing> {
  const response = await hostedFetch(signed.hosted, "/api/claxedo/credentials/sandbox-drivers", {}, signed.owner.person)
  expect(response.status).toBe(200)
  return await response.json() as SandboxListing
}

test("15 settings: signed out, Sandbox providers asks for a sign-in instead of offering a key", async ({ stack, app }) => {
  await app.goto(`${stack.url}/settings/sandbox`)
  await expect(app.getByRole("link", { name: "Sandbox providers", exact: true })).toHaveAttribute("aria-current", "page")
  await expect(app.getByText("Sign in to see your organization.", { exact: true })).toBeVisible()
  await expect(app.getByRole("button", { name: "Add a key…", exact: true })).toHaveCount(0)
})

test("15 settings: an organization owner removes the sandbox provider key through the dialog, adds one back, and sees it in use", async ({ signed, page, isMobile }) => {
  await signed.signIn(page, signed.owner)
  await page.goto(`${signed.url}/settings/sandbox`)
  await expect(page.getByRole("link", { name: "Sandbox providers", exact: true })).toHaveAttribute("aria-current", "page")
  const defaultProvider = page.getByRole("group", { name: "Default provider" })
  await expect(defaultProvider.getByRole("button", { name: "Cloudflare", exact: true })).toBeVisible()
  expect(await sandboxListing(signed)).toMatchObject({ default_driver: "cloudflare", keys: [{ provider_id: "cloudflare" }] })

  const remove = page.getByRole("button", { name: "Remove key", exact: true })
  if (isMobile) {
    const box = await remove.boundingBox()
    expect(box?.height).toBeGreaterThanOrEqual(44)
    expect(box?.width).toBeGreaterThanOrEqual(44)
  }
  await remove.click()
  const confirm = page.getByRole("dialog", { name: "Remove this key?" })
  await expect(confirm).toContainText("Cloudflare")
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(confirm).toHaveCount(0)
  expect(await sandboxListing(signed)).toMatchObject({ keys: [{ provider_id: "cloudflare" }] })
  await remove.click()
  const confirmRemove = confirm.getByRole("button", { name: "Remove key", exact: true })
  await expect(confirmRemove).toHaveAttribute("data-variant", "danger")
  await confirmRemove.click()
  await expect(page.getByText("No sandbox keys yet.", { exact: true })).toBeVisible()
  await expect(page.getByText("None yet", { exact: true })).toBeVisible()
  expect(await sandboxListing(signed)).toMatchObject({ default_driver: null, keys: [] })

  await page.getByRole("button", { name: "Add a key…", exact: true }).click()
  const form = page.getByRole("dialog", { name: "Add a sandbox key" })
  await form.getByLabel("API Token", { exact: true }).fill(HOSTED_SANDBOX_TEST_TOKEN)
  await form.getByRole("textbox", { name: "Worker URL", exact: true }).fill(signed.hosted.sandboxOrigin)
  await form.getByRole("button", { name: "Save key", exact: true }).click()

  await expect(form).toHaveCount(0)
  await expect(defaultProvider.getByRole("button", { name: "Cloudflare", exact: true })).toBeVisible()
  expect(await sandboxListing(signed)).toMatchObject({ default_driver: "cloudflare", keys: [{ provider_id: "cloudflare" }] })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

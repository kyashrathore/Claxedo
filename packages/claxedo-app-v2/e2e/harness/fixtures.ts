import { test as base, expect, type Page } from "@playwright/test"
import { ClaxedoApi } from "./api"
import { startStack, type Stack } from "./stack"

export type HarnessFixtures = {
  stack: Stack
  api: ClaxedoApi
  app: Page
}

export const test = base.extend<HarnessFixtures>({
  stack: async ({}, use, testInfo) => {
    const stack = await startStack({ label: testInfo.titlePath.join(" ") })
    try {
      await use(stack)
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach("daemon.log", { body: stack.daemon.log(), contentType: "text/plain" })
      }
      await stack.close()
    }
  },
  api: async ({ stack }, use) => {
    await use(new ClaxedoApi(stack.url))
  },
  app: async ({ stack, page }, use) => {
    await page.goto(`${stack.url}/`)
    await use(page)
  },
})

export { expect }

import { test as base, expect, type Page } from "@playwright/test"
import { ClaxedoApi } from "./api"
import { unexpectedEgress, type EgressAttempt } from "./egress-guard"
import { startStack, type Stack } from "./stack"

export type HarnessFixtures = {
  stack: Stack
  api: ClaxedoApi
  app: Page
}

function refuseEgress(attempts: EgressAttempt[]) {
  const unexpected = unexpectedEgress(attempts)
  if (unexpected.length === 0) return
  const targets = unexpected.map((attempt) => `${attempt.method} ${attempt.target}`).join(", ")
  throw new Error(`${unexpected.length} request(s) tried to leave the machine and were refused: ${targets}`)
}

export const test = base.extend<HarnessFixtures>({
  stack: async ({}, use, testInfo) => {
    const stack = await startStack({ label: testInfo.titlePath.join(" ") })
    try {
      await use(stack)
    } finally {
      if (testInfo.status !== testInfo.expectedStatus || unexpectedEgress(stack.egress.attempts).length > 0) {
        await testInfo.attach("daemon.log", { body: stack.daemon.log(), contentType: "text/plain" })
      }
      await stack.close()
    }
    refuseEgress(stack.egress.attempts)
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

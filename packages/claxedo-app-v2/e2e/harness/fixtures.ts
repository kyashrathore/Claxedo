import { test as base, expect, type Page, type TestInfo } from "@playwright/test"
import { ClaxedoApi } from "./api"
import { appChoice } from "./app"
import { launchDesktop, type Desktop } from "./desktop"
import { ensureDesktopBuilt, type DesktopBuild } from "./desktop-build"
import { unexpectedEgress, type EgressAttempt } from "./egress-guard"
import { redRun, startStack, type Stack } from "./stack"

export type HarnessFixtures = {
  stack: Stack
  api: ClaxedoApi
  app: Page
  desktop: Desktop
}

type HarnessWorkerFixtures = { desktopBuild: DesktopBuild }

function refuseEgress(attempts: EgressAttempt[]) {
  const unexpected = unexpectedEgress(attempts)
  if (unexpected.length === 0) return
  const targets = unexpected.map((attempt) => `${attempt.method} ${attempt.target}`).join(", ")
  throw new Error(`${unexpected.length} request(s) tried to leave the machine and were refused: ${targets}`)
}

async function attachLogOnFailure(testInfo: TestInfo, attempts: EgressAttempt[], name: string, log: () => string) {
  if (testInfo.status === testInfo.expectedStatus && unexpectedEgress(attempts).length === 0) return
  await testInfo.attach(name, { body: log(), contentType: "text/plain" })
}

export const test = base.extend<HarnessFixtures, HarnessWorkerFixtures>({
  stack: async ({}, use, testInfo) => {
    const stack = await startStack({ label: testInfo.titlePath.join(" ") })
    try {
      await use(stack)
    } finally {
      await attachLogOnFailure(testInfo, stack.egress.attempts, "daemon.log", stack.daemon.log)
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
  desktopBuild: [
    async ({}, use) => {
      await use(await ensureDesktopBuilt(appChoice()))
    },
    { scope: "worker", timeout: 300_000 },
  ],
  desktop: async ({ desktopBuild }, use, testInfo) => {
    const how = desktopBuild.built ? `built in ${desktopBuild.ms} ms` : "already current"
    testInfo.annotations.push({ type: "desktop build", description: how })
    const desktop = await launchDesktop({ label: testInfo.title, red: redRun() })
    try {
      await use(desktop)
    } finally {
      await attachLogOnFailure(testInfo, desktop.egress.attempts, "desktop.log", desktop.log)
      await desktop.close()
    }
    refuseEgress(desktop.egress.attempts)
  },
})

export { expect }

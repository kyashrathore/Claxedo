import { test as base, expect, type Page, type TestInfo } from "@playwright/test"
import { ClaxedoApi } from "./api"
import { appChoice, ensureAppBuilt, signedDistDir, type AppBuild } from "./app"
import { launchDesktop, type Desktop, type DesktopAccount } from "./desktop"
import { recordDestinations, reportDestinations } from "./destinations"
import { ensureDesktopBuilt, type DesktopBuild } from "./desktop-build"
import { unexpectedEgress, type EgressAttempt } from "./egress-guard"
import { releasePort, reservePort } from "./ports"
import { startSignedStack, type SignedStack } from "./signed-stack"
import { redRun, startStack, type Stack } from "./stack"

export type HarnessFixtures = {
  stack: Stack
  api: ClaxedoApi
  app: Page
  desktop: Desktop
  signed: SignedStack
  signedDesktop: Desktop
  signedCloud: SignedStack
}

type SignedBuild = AppBuild & { frontPort: number }

type HarnessWorkerFixtures = { desktopBuild: DesktopBuild; signedBuild: SignedBuild }

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
  context: async ({ context }, use, testInfo) => {
    const destinations = recordDestinations(context)
    await use(context)
    await reportDestinations(testInfo, destinations)
  },
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
  signedBuild: [
    async ({}, use) => {
      const frontPort = await reservePort()
      try {
        const build = await ensureAppBuilt(appChoice(), { serverUrl: `https://127.0.0.1:${frontPort}`, outDir: signedDistDir(appChoice()) })
        await use({ ...build, frontPort })
      } finally {
        releasePort(frontPort)
      }
    },
    { scope: "worker", timeout: 300_000 },
  ],
  signed: async ({ signedBuild }, use, testInfo) => {
    const signed = await startSignedStack({ label: testInfo.titlePath.join(" "), frontPort: signedBuild.frontPort, distDir: signedBuild.distDir })
    try {
      await use(signed)
    } finally {
      await attachLogOnFailure(testInfo, signed.stack.egress.attempts, "daemon.log", signed.stack.daemon.log)
      await signed.close()
    }
    refuseEgress(signed.stack.egress.attempts)
  },
  signedCloud: async ({ signedBuild }, use, testInfo) => {
    const signed = await startSignedStack({ label: testInfo.titlePath.join(" "), frontPort: signedBuild.frontPort, distDir: signedBuild.distDir, cloud: true })
    try {
      await use(signed)
    } finally {
      await attachLogOnFailure(testInfo, signed.stack.egress.attempts, "daemon.log", signed.stack.daemon.log)
      await attachLogOnFailure(testInfo, signed.stack.egress.attempts, "relay.log", signed.relayLog)
      await signed.close()
    }
    refuseEgress(signed.stack.egress.attempts)
  },
  desktop: async ({ desktopBuild }, use, testInfo) => {
    await useDesktop(testInfo, desktopBuild, undefined, use)
  },
  signedDesktop: async ({ desktopBuild, signed }, use, testInfo) => {
    await useDesktop(testInfo, desktopBuild, { coreOrigin: signed.url, trust: signed.trust }, use)
  },
})

async function useDesktop(testInfo: TestInfo, desktopBuild: DesktopBuild, account: DesktopAccount | undefined, use: (desktop: Desktop) => Promise<void>) {
  const how = desktopBuild.built ? `built in ${desktopBuild.ms} ms` : "already current"
  testInfo.annotations.push({ type: "desktop build", description: how })
  const desktop = await launchDesktop({ label: testInfo.title, red: redRun(), ...(account ? { account } : {}) })
  try {
    await use(desktop)
  } finally {
    await attachLogOnFailure(testInfo, desktop.egress.attempts, "desktop.log", desktop.log)
    await desktop.close()
  }
  refuseEgress(desktop.egress.attempts)
}

export { expect }

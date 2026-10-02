import { test as base, expect, type Page, type TestInfo } from "@playwright/test"
import { ClaxedoApi } from "./api"
import { ensureAppBuilt, signedDistDir, type AppBuild } from "./app"
import { launchDesktop, type Desktop, type DesktopAccount } from "./desktop"
import { recordDestinations, reportDestinations } from "./destinations"
import { ensureDesktopBuilt, type DesktopBuild } from "./desktop-build"
import type { DesktopRenderer } from "./desktop-renderer"
import { unexpectedEgress, type EgressAttempt } from "../../../harness/e2e/harness/egress-guard"
import { releasePort, reservePort } from "../../../harness/e2e/harness/ports"
import { signedOrigin, startSignedStack, type SignedStack } from "./signed-stack"
import { redRun, startStack, type Stack } from "./stack"

export type HarnessFixtures = {
  stack: Stack
  api: ClaxedoApi
  app: Page
  desktopRenderer: DesktopRenderer
  desktop: Desktop
  signed: SignedStack
  signedDesktop: Desktop
  signedCloud: SignedStack
}

type SignedBuild = AppBuild & { frontPort: number; relayPort: number }

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

async function useSignedFixture(build: SignedBuild, testInfo: TestInfo, use: (signed: SignedStack) => Promise<void>) {
  const signed = await startSignedStack({ label: testInfo.titlePath.join(" "), frontPort: build.frontPort, relayPort: build.relayPort, distDir: build.distDir })
  try {
    await use(signed)
  } finally {
    await attachLogOnFailure(testInfo, signed.local.egress.attempts, "daemon.log", signed.local.daemon.log)
    const outbound = await signed.hosted.outboundAttempts()
    await signed.close()
    refuseEgress(signed.local.egress.attempts)
    expect(outbound).toEqual([])
  }
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
      await use(await ensureDesktopBuilt())
    },
    { scope: "worker", timeout: 300_000 },
  ],
  signedBuild: [
    async ({}, use) => {
      const frontPort = await reservePort()
      const relayPort = await reservePort()
      try {
        const build = await ensureAppBuilt({ serverUrl: signedOrigin(frontPort), outDir: signedDistDir(), relayOrigins: [`http://127.0.0.1:${relayPort}`] })
        await use({ ...build, frontPort, relayPort })
      } finally {
        releasePort(frontPort)
        releasePort(relayPort)
      }
    },
    { scope: "worker", timeout: 300_000 },
  ],
  signed: [async ({ signedBuild }, use, testInfo) => {
    await useSignedFixture(signedBuild, testInfo, use)
  }, { timeout: 120_000 }],
  signedCloud: [async ({ signedBuild }, use, testInfo) => {
    await useSignedFixture(signedBuild, testInfo, use)
  }, { timeout: 120_000 }],
  desktopRenderer: ["file", { option: true }],
  desktop: async ({ desktopBuild, desktopRenderer }, use, testInfo) => {
    await useDesktop(testInfo, desktopBuild, desktopRenderer, undefined, use)
  },
  signedDesktop: async ({ desktopBuild, desktopRenderer, signedCloud }, use, testInfo) => {
    await useDesktop(testInfo, desktopBuild, desktopRenderer, { coreOrigin: signedCloud.url, relayOrigins: [signedCloud.hosted.relayUrl], trust: signedCloud.trust }, use)
  },
})

async function useDesktop(
  testInfo: TestInfo,
  desktopBuild: DesktopBuild,
  renderer: DesktopRenderer,
  account: DesktopAccount | undefined,
  use: (desktop: Desktop) => Promise<void>,
) {
  const how = desktopBuild.built ? `built in ${desktopBuild.ms} ms` : "already current"
  testInfo.annotations.push({ type: "desktop build", description: how })
  const desktop = await launchDesktop({ label: testInfo.title, red: redRun(), renderer, ...(account ? { account } : {}) })
  try {
    await use(desktop)
  } finally {
    await attachLogOnFailure(testInfo, desktop.egress.attempts, "desktop.log", desktop.log)
    await desktop.close()
  }
  refuseEgress(desktop.egress.attempts)
}

export { expect }

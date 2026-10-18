# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 15-settings-models.spec.ts >> 15 settings: Models lists each agent's accounts and this computer's logins
- Location: e2e/flows/15-settings-models.spec.ts:54:1

# Error details

```
Error: 8 request(s) tried to leave the machine and were refused: CONNECT api.anthropic.com:443, CONNECT api.anthropic.com:443, CONNECT api.anthropic.com:443, CONNECT api.anthropic.com:443, CONNECT api.anthropic.com:443, CONNECT api.anthropic.com:443, CONNECT api.anthropic.com:443, CONNECT api.anthropic.com:443
```

# Test source

```ts
  1   | import { test as base, expect, type Page, type TestInfo } from "@playwright/test"
  2   | import { ClaxedoApi } from "./api"
  3   | import { ensureAppBuilt, signedDistDir, type AppBuild } from "./app"
  4   | import { launchDesktop, type Desktop, type DesktopAccount } from "./desktop"
  5   | import { recordDestinations, reportDestinations } from "./destinations"
  6   | import { ensureDesktopBuilt, type DesktopBuild } from "./desktop-build"
  7   | import type { DesktopRenderer } from "./desktop-renderer"
  8   | import { unexpectedEgress, type EgressAttempt } from "../../../harness/e2e/harness/egress-guard"
  9   | import { releasePort, reservePort } from "../../../harness/e2e/harness/ports"
  10  | import { signedOrigin, startSignedStack, type SignedStack } from "./signed-stack"
  11  | import { redRun, startStack, type Stack } from "./stack"
  12  | 
  13  | export type HarnessFixtures = {
  14  |   stack: Stack
  15  |   api: ClaxedoApi
  16  |   app: Page
  17  |   desktopRenderer: DesktopRenderer
  18  |   desktop: Desktop
  19  |   signed: SignedStack
  20  |   signedDesktop: Desktop
  21  |   signedCloud: SignedStack
  22  | }
  23  | 
  24  | type SignedBuild = AppBuild & { frontPort: number; relayPort: number }
  25  | 
  26  | type HarnessWorkerFixtures = { desktopBuild: DesktopBuild; signedBuild: SignedBuild }
  27  | 
  28  | function refuseEgress(attempts: EgressAttempt[]) {
  29  |   const unexpected = unexpectedEgress(attempts)
  30  |   if (unexpected.length === 0) return
  31  |   const targets = unexpected.map((attempt) => `${attempt.method} ${attempt.target}`).join(", ")
> 32  |   throw new Error(`${unexpected.length} request(s) tried to leave the machine and were refused: ${targets}`)
      |         ^ Error: 8 request(s) tried to leave the machine and were refused: CONNECT api.anthropic.com:443, CONNECT api.anthropic.com:443, CONNECT api.anthropic.com:443, CONNECT api.anthropic.com:443, CONNECT api.anthropic.com:443, CONNECT api.anthropic.com:443, CONNECT api.anthropic.com:443, CONNECT api.anthropic.com:443
  33  | }
  34  | 
  35  | async function attachLogOnFailure(testInfo: TestInfo, attempts: EgressAttempt[], name: string, log: () => string) {
  36  |   if (testInfo.status === testInfo.expectedStatus && unexpectedEgress(attempts).length === 0) return
  37  |   await testInfo.attach(name, { body: log(), contentType: "text/plain" })
  38  | }
  39  | 
  40  | async function useSignedFixture(build: SignedBuild, testInfo: TestInfo, use: (signed: SignedStack) => Promise<void>) {
  41  |   const signed = await startSignedStack({ label: testInfo.titlePath.join(" "), frontPort: build.frontPort, relayPort: build.relayPort, distDir: build.distDir })
  42  |   try {
  43  |     await use(signed)
  44  |   } finally {
  45  |     await attachLogOnFailure(testInfo, signed.local.egress.attempts, "daemon.log", signed.local.daemon.log)
  46  |     const outbound = await signed.hosted.outboundAttempts()
  47  |     await signed.close()
  48  |     refuseEgress(signed.local.egress.attempts)
  49  |     expect(outbound).toEqual([])
  50  |   }
  51  | }
  52  | 
  53  | export const test = base.extend<HarnessFixtures, HarnessWorkerFixtures>({
  54  |   context: async ({ context }, use, testInfo) => {
  55  |     const destinations = recordDestinations(context)
  56  |     await use(context)
  57  |     await reportDestinations(testInfo, destinations)
  58  |   },
  59  |   stack: async ({}, use, testInfo) => {
  60  |     const stack = await startStack({ label: testInfo.titlePath.join(" ") })
  61  |     try {
  62  |       await use(stack)
  63  |     } finally {
  64  |       await attachLogOnFailure(testInfo, stack.egress.attempts, "daemon.log", stack.daemon.log)
  65  |       await stack.close()
  66  |     }
  67  |     refuseEgress(stack.egress.attempts)
  68  |   },
  69  |   api: async ({ stack }, use) => {
  70  |     await use(new ClaxedoApi(stack.url))
  71  |   },
  72  |   app: async ({ stack, page }, use) => {
  73  |     await page.goto(`${stack.url}/`)
  74  |     await use(page)
  75  |   },
  76  |   desktopBuild: [
  77  |     async ({}, use) => {
  78  |       await use(await ensureDesktopBuilt())
  79  |     },
  80  |     { scope: "worker", timeout: 300_000 },
  81  |   ],
  82  |   signedBuild: [
  83  |     async ({}, use) => {
  84  |       const frontPort = await reservePort()
  85  |       const relayPort = await reservePort()
  86  |       try {
  87  |         const build = await ensureAppBuilt({ serverUrl: signedOrigin(frontPort), outDir: signedDistDir(), relayOrigins: [`http://127.0.0.1:${relayPort}`] })
  88  |         await use({ ...build, frontPort, relayPort })
  89  |       } finally {
  90  |         releasePort(frontPort)
  91  |         releasePort(relayPort)
  92  |       }
  93  |     },
  94  |     { scope: "worker", timeout: 300_000 },
  95  |   ],
  96  |   signed: [async ({ signedBuild }, use, testInfo) => {
  97  |     await useSignedFixture(signedBuild, testInfo, use)
  98  |   }, { timeout: 120_000 }],
  99  |   signedCloud: [async ({ signedBuild }, use, testInfo) => {
  100 |     await useSignedFixture(signedBuild, testInfo, use)
  101 |   }, { timeout: 120_000 }],
  102 |   desktopRenderer: ["file", { option: true }],
  103 |   desktop: async ({ desktopBuild, desktopRenderer }, use, testInfo) => {
  104 |     await useDesktop(testInfo, desktopBuild, desktopRenderer, undefined, use)
  105 |   },
  106 |   signedDesktop: async ({ desktopBuild, desktopRenderer, signedCloud }, use, testInfo) => {
  107 |     await useDesktop(testInfo, desktopBuild, desktopRenderer, { coreOrigin: signedCloud.url, relayOrigins: [signedCloud.hosted.relayUrl], trust: signedCloud.trust }, use)
  108 |   },
  109 | })
  110 | 
  111 | async function useDesktop(
  112 |   testInfo: TestInfo,
  113 |   desktopBuild: DesktopBuild,
  114 |   renderer: DesktopRenderer,
  115 |   account: DesktopAccount | undefined,
  116 |   use: (desktop: Desktop) => Promise<void>,
  117 | ) {
  118 |   const how = desktopBuild.built ? `built in ${desktopBuild.ms} ms` : "already current"
  119 |   testInfo.annotations.push({ type: "desktop build", description: how })
  120 |   const desktop = await launchDesktop({ label: testInfo.title, red: redRun(), renderer, ...(account ? { account } : {}) })
  121 |   try {
  122 |     await use(desktop)
  123 |   } finally {
  124 |     await attachLogOnFailure(testInfo, desktop.egress.attempts, "desktop.log", () => desktop.log())
  125 |     await desktop.close()
  126 |   }
  127 |   refuseEgress(desktop.egress.attempts)
  128 | }
  129 | 
  130 | export { expect }
  131 | 
```
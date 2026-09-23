/**
 * Web lane: signed, cloud workspace, through the real relay.
 *
 * Thin configuration wrapper: every scenario body lives in
 * `e2e/helpers/web-signed-relay-journeys.ts`, shared with
 * `web-signed-host-tunnel.spec.ts`. This file boots the shared fixture with
 * `backing: "cloud-vm"`, builds and serves the production web bundle against it,
 * and wires each scenario id to its journey. Test titles carry the ids of the
 * scenario matrix shared with the `desktop-*` lanes (A = shell integrity,
 * B = session lifecycle & rail, C = composer & harness, D = terminal,
 * E = rail geometry).
 *
 * Real: the built web app (`vite build && vite preview`,
 * `web-signed-relay-harness.ts`), the `hosted-node` control plane on
 * `createSqliteCentralStore` behind `customVerifierAuthAdapter`, a
 * `@claxedo/workspace-relay` process, and an in-process cloud
 * workspace-runtime (`signed-browser-relay-fixture.mjs`'s `startCloudRuntime`).
 * The only fake is the model HTTP endpoint.
 *
 * Fixed backend/preview ports (4527/4529, overridable by env): a build needs
 * its backend URL before it starts, and each signed lane has its own port
 * block. `CLAXEDO_E2E_RELAY_FIXTURE_BACKING=cloud-vm` selects `startCloudRuntime`
 * in the fixture.
 */
import { expect, test, type Page } from "@playwright/test"
import path from "node:path"
import {
  buildAndServeWebApp,
  gateReachesReady,
  seedWorkspace,
  sessionRoute,
  startSignedRelayFixture,
  type RunningRelayFixture,
  type RunningWebApp,
} from "../helpers/web-signed-relay-harness"
import {
  journeyA2,
  journeyA3,
  journeyB1toB4,
  journeyB5B6,
  journeyB7,
  journeyB8,
  journeyB9,
  journeyC1,
  journeyC4,
  journeyD1toD3E1,
  watchForbiddenDirectRequests,
  type JourneyCtx,
} from "../helpers/web-signed-relay-journeys"
import { startScriptedModelServer, type ScriptedModelServer } from "../helpers/scripted-model-server"

const TIER_REAL = process.env.CLAXEDO_TIER_REAL_E2E === "1"
const SPEC = "web-signed-cloud"
const APP_DIR = path.resolve(import.meta.dirname, "..", "..")
const BACKEND_PORT = Number(process.env.CLAXEDO_WEB_SIGNED_CLOUD_BACKEND_PORT ?? 4527)
const PREVIEW_PORT = Number(process.env.CLAXEDO_WEB_SIGNED_CLOUD_PREVIEW_PORT ?? 4529)
const OUT_DIR = path.join(APP_DIR, "dist-e2e-web-signed-cloud")

let scripted: ScriptedModelServer | undefined
let fixture: RunningRelayFixture | undefined
let webApp: RunningWebApp | undefined
let forbiddenHits: string[] = []
function ctx(page: Page): JourneyCtx {
  return {
    page,
    frontendUrl: webApp!.url,
    info: fixture!.info,
    scripted: scripted!,
    spec: SPEC,
    backing: "cloud-vm",
  }
}

test.describe("web signed cloud @core @tier-real @surface-web", () => {
  test.skip(
    !TIER_REAL,
    "Tier R: set CLAXEDO_TIER_REAL_E2E=1 to run web-signed-cloud against a real relay process, a real in-process " +
      "cloud workspace-runtime, the real hosted-node control plane, and a built production web bundle.",
  )

  test.beforeAll(async ({ browser }) => {
    if (!TIER_REAL) return
    test.setTimeout(180_000)
    scripted = await startScriptedModelServer()
    fixture = await startSignedRelayFixture({
      backing: "cloud-vm",
      backendPort: BACKEND_PORT,
      browserUrl: `http://app.localhost:${PREVIEW_PORT}`,
      scripted,
      claudeConfigDir: path.join(APP_DIR, "..", "..", "node_modules", ".cache", "web-signed-cloud-claude"),
    })
    webApp = await buildAndServeWebApp({
      backendUrl: fixture.info.backendUrl,
      relayUrl: fixture.info.relayUrl,
      outDir: OUT_DIR,
      previewPort: PREVIEW_PORT,
    })
    const probe = await browser.newPage()
    try {
      await seedWorkspace(probe, fixture.info, "cloud-vm")
      await probe.goto(`${webApp.url}${sessionRoute(fixture.info)}`, { waitUntil: "domcontentloaded", timeout: 45_000 })
      await gateReachesReady(probe, 45_000)
    } finally {
      await probe.close()
    }
  })

  test.afterAll(async () => {
    if (!TIER_REAL) return
    try {
      expect(forbiddenHits, `forbidden direct-path requests observed: ${JSON.stringify(forbiddenHits)}`).toEqual([])
    } finally {
      await Promise.allSettled([webApp?.close(), fixture?.close(), scripted?.close()])
    }
  })

  test.beforeEach(async ({ page }) => {
    if (!TIER_REAL) return
    test.setTimeout(180_000)
    watchForbiddenDirectRequests(page, new URL(fixture!.info.backendUrl).origin, forbiddenHits)
  })

  // DIAGNOSTIC, permanent — see the identical note in `web-signed-host-tunnel
  // .spec.ts`: surfaces the fixture's own server log on any non-green result,
  // which is otherwise invisible from a client-side Playwright error alone.
  test.afterEach(async () => {
    const testInfo = test.info()
    if (!TIER_REAL || testInfo.status === testInfo.expectedStatus) return
    console.log(
      `\n[web-signed-cloud] fixture log tail after "${testInfo.title}" (${testInfo.status}):\n${fixture?.log().slice(-4000)}`,
    )
  })

  test("A2: reload mid-session still renders the transcript and completes a further turn", async ({ page }) => {
    await journeyA2(ctx(page))
  })

  test("A3: a cold deep link /w/<ws>/session/<id> loads that session", async ({ page }) => {
    await journeyA3(ctx(page))
  })

  test("B1/B2/B3/B4: a new session's row appears live, completes a turn, auto-titles, and accepts a second message", async ({
    page,
  }) => {
    await journeyB1toB4(ctx(page))
  })

  test("B5/B6: re-prompting an older row bumps it to the top, and its row stays unique", async ({ page }) => {
    test.setTimeout(150_000)
    await journeyB5B6(ctx(page))
  })

  test("B7: the background status dot transitions working -> done on a row mounted while idle and never focused", async ({
    page,
  }) => {
    await journeyB7(ctx(page))
  })

  test("B8: reload preserves rail title, order, and status", async ({ page }) => {
    await journeyB8(ctx(page))
  })

  test("B9: sidebar and compact-switcher status dots agree, including a transition on an already-mounted tab", async ({
    page,
  }) => {
    await journeyB9(ctx(page))
  })

  test("C1: a new draft resolves harness/model within 5s with no reload needed", async ({ page }) => {
    await journeyC1(ctx(page))
  })

  test("C4: switching harness survives a reload and completes a second turn", async ({ page }) => {
    test.setTimeout(180_000)
    await journeyC4(ctx(page))
  })

  test("D1/D2/D3/E1: a real terminal streams a live prompt and its row aligns with session rows", async ({ page }) => {
    test.setTimeout(120_000)
    await journeyD1toD3E1(ctx(page))
  })
})

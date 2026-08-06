/**
 * SPEC: web lane — signed, cloud workspace, through the real relay
 * (`docs/plans/2026-08-06-001-test-full-matrix-real-e2e-plan.md`, Phase 4)
 *
 * PURPOSE — the plan's lane x scenario matrix (line 157) assigns this lane
 * A2-A3, all of B, C1/C4, D1-D2, E1, and F3 ("cloud: same through the relay;
 * reload replays from the remote runtime"). Like its sibling `web-signed-
 * userhosted.spec.ts`, this file is a THIN CONFIGURATION WRAPPER: every
 * scenario body lives once in `e2e/helpers/web-signed-relay-journeys.ts`,
 * shared verbatim between the two lanes. This file owns only: booting the
 * shared fixture with `access: "cloud"`, building and serving the REAL
 * production web bundle against it, and wiring each plan scenario id to its
 * shared journey function.
 *
 * WHAT IS REAL HERE — the built production web app (`vite build && vite
 * preview`, see `web-signed-relay-harness.ts`'s file header), the real
 * `hosted-node` control plane on `createSqliteCentralStore` behind
 * `customVerifierAuthAdapter` (plan Phase 3), a real `@claxedo/workspace-
 * relay` process, and a real in-process cloud workspace-runtime engine
 * (`signed-browser-relay-fixture.mjs`'s `startCloudRuntime`, wired to the
 * REAL embedded engine transport per that fixture's own inline fix note, not
 * the `forbiddenOpencodeServer()` stub). The ONE fake is the model HTTP
 * endpoint.
 *
 * KNOWN BLOCKER, inherited and re-verified here rather than assumed —
 * `real-cloud-relay.spec.ts` (this same fixture, `access: "cloud"`, driven
 * against a dedicated DEV-server frontend instead of a built one) documents an
 * OPEN product gap: the cloud connect gate (`workspace-connection.ts` ->
 * `prepareWorkspaceRuntime` -> `resolveWorkspaceRuntime`) reports "Workspace
 * startup failed" for a workspace that is already `status:"ready"`, so no
 * composer is ever reachable and every scenario below that needs one is
 * blocked on the SAME root cause, independent of which frontend serves the
 * page. This file's own `beforeAll` reproduces that check directly — see the
 * "GATE PROBE" step below — and `test.fixme`s every downstream scenario with a
 * citation to the exact probe result if the gate has not reached ready,
 * rather than letting each scenario time out separately with a less legible
 * failure. If a future fix lands in `prepareWorkspaceRuntime`, the probe
 * flips green on its own and every `test.fixme` below should be revisited
 * (search this file for "GATE PROBE").
 *
 * HARNESS NOTES —
 *   - Fixed backend/preview ports (4527/4529, overridable by env) — see the
 *     sibling spec's identical note and `web-signed-relay-harness.ts`'s file
 *     header for why a build needs its backend URL known in advance.
 *   - `CLAXEDO_E2E_RELAY_FIXTURE_ACCESS=cloud` is what selects `startCloudRuntime`
 *     in the fixture instead of the user-hosted tunnel branch.
 */
import { expect, test } from "@playwright/test"
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
  fixtureOpencodeRequests,
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
/** Set by the GATE PROBE in `beforeAll` — see this file's header. `undefined` until the probe runs. */
let gateProbeError: string | undefined

function ctx(): JourneyCtx {
  return { page: undefined as never, frontendUrl: webApp!.url, info: fixture!.info, scripted: scripted!, spec: SPEC, kind: "cloud" }
}

test.describe("web signed cloud @core @tier-real @surface-web", () => {
  test.skip(
    !TIER_REAL,
    "Tier R: set CLAXEDO_TIER_REAL_E2E=1 to run web-signed-cloud against a real relay process, a real in-process " +
      "cloud workspace-runtime, the real hosted-node control plane, and a REAL BUILT production web bundle (see " +
      "this file's HARNESS NOTES). Unset -> loud, visible skip per e2e/INVARIANTS.md rule 6, never a silent no-op.",
  )

  test.beforeAll(async () => {
    if (!TIER_REAL) return
    test.setTimeout(180_000)
    scripted = await startScriptedModelServer()
    fixture = await startSignedRelayFixture({
      access: "cloud",
      backendPort: BACKEND_PORT,
      scripted,
      claudeConfigDir: path.join(APP_DIR, "..", "..", "node_modules", ".cache", "web-signed-cloud-claude"),
    })
    webApp = await buildAndServeWebApp({ backendUrl: fixture.info.backendUrl, outDir: OUT_DIR, previewPort: PREVIEW_PORT })
  })

  test.afterAll(async () => {
    if (!TIER_REAL) return
    if (!gateProbeError) {
      expect(forbiddenHits, `forbidden direct-path requests observed: ${JSON.stringify(forbiddenHits)}`).toEqual([])
    }
    await webApp?.close()
    await fixture?.close()
    await scripted?.close()
  })

  test.beforeEach(async ({ page }) => {
    if (!TIER_REAL) return
    test.setTimeout(180_000)
    forbiddenHits.push(...watchForbiddenDirectRequests(page, new URL(fixture!.info.backendUrl).origin))
  })

  // DIAGNOSTIC, permanent — see the identical note in `web-signed-userhosted
  // .spec.ts`: surfaces the fixture's own server log on any non-green result,
  // which is otherwise invisible from a client-side Playwright error alone.
  test.afterEach(async ({}, testInfo) => {
    if (!TIER_REAL || testInfo.status === testInfo.expectedStatus) return
    console.log(`\n[web-signed-cloud] fixture log tail after "${testInfo.title}" (${testInfo.status}):\n${fixture?.log().slice(-4000)}`)
  })

  /**
   * GATE PROBE — not a plan scenario in its own right. Runs FIRST, once,
   * against a throwaway page, and records whether the cloud connect gate
   * reaches ready at all. Every scenario below reads `gateProbeError` and
   * `test.fixme`s itself with the exact probe failure if it is set, rather
   * than each independently burning its own multi-minute timeout on the same
   * root cause with a less legible error. If this probe passes, it also
   * doubles as this lane's own A1-equivalent diagnostic (the composer is
   * reachable at all) before any scenario spends real turns proving more.
   */
  test("GATE PROBE: the cloud connect gate reaches ready (not a plan scenario — see file header)", async ({ page }) => {
    if (!TIER_REAL) return
    await seedWorkspace(page, fixture!.info, "cloud")
    await page.goto(`${webApp!.url}${sessionRoute(fixture!.info)}`, { waitUntil: "domcontentloaded", timeout: 45_000 })
    try {
      await gateReachesReady(page, 45_000)
    } catch (err) {
      gateProbeError =
        `cloud connect gate did not reach ready: ${String(err)}. This reproduces real-cloud-relay.spec.ts's ` +
        `documented "Workspace startup failed" blocker (prepareWorkspaceRuntime's resolve rejecting an already-` +
        `ready cloud workspace) against a BUILT web bundle instead of that spec's dev-server one, ruling out the ` +
        `build-vs-dev-server axis as the cause. See docs/plans/2026-08-06-001-test-full-matrix-real-e2e-plan.md, ` +
        `real-cloud-relay.spec.ts's HARNESS NOTES "REMAINING BLOCKER".`
      throw new Error(`GATING: ${gateProbeError}`)
    }
  })

  test("A2: reload mid-session still renders the transcript and completes a further turn", async ({ page }) => {
    test.fixme(!!gateProbeError, gateProbeError)
    await journeyA2({ ...ctx(), page })
  })

  test("A3: a cold deep link /w/<ws>/session/<id> loads that session", async ({ page }) => {
    test.fixme(!!gateProbeError, gateProbeError)
    await journeyA3({ ...ctx(), page })
  })

  test("B1/B2/B3/B4: a new session's row appears live, completes a turn, auto-titles, and accepts a second message", async ({
    page,
  }) => {
    test.fixme(!!gateProbeError, gateProbeError)
    await journeyB1toB4({ ...ctx(), page })
  })

  test("B5/B6: re-prompting an older row bumps it to the top, and its row stays unique", async ({ page }) => {
    test.setTimeout(150_000)
    test.fixme(!!gateProbeError, gateProbeError)
    await journeyB5B6({ ...ctx(), page })
  })

  test("B7: the background status dot transitions working -> done on a row mounted while idle and never focused", async ({
    page,
  }) => {
    test.fixme(!!gateProbeError, gateProbeError)
    await journeyB7({ ...ctx(), page })
  })

  test("B8: reload preserves rail title, order, and status", async ({ page }) => {
    test.fixme(!!gateProbeError, gateProbeError)
    await journeyB8({ ...ctx(), page })
  })

  test("B9: sidebar and compact-switcher status dots agree, including a transition on an already-mounted tab", async ({
    page,
  }) => {
    test.fixme(!!gateProbeError, gateProbeError)
    await journeyB9({ ...ctx(), page })
  })

  test("C1: a new draft resolves harness/model within 5s with no reload needed", async ({ page }) => {
    test.fixme(!!gateProbeError, gateProbeError)
    await journeyC1({ ...ctx(), page })
  })

  test("C4: switching harness survives a reload and completes a second turn", async ({ page }) => {
    test.setTimeout(180_000)
    test.fixme(!!gateProbeError, gateProbeError)
    await journeyC4({ ...ctx(), page })
  })

  test("D1/D2/D3/E1: a real terminal streams a live prompt and its row aligns with session rows", async ({ page }) => {
    test.setTimeout(120_000)
    test.fixme(!!gateProbeError, gateProbeError)
    await journeyD1toD3E1({ ...ctx(), page })
  })

  test("F3: nothing in the journey ever hit the fixture's forbidden legacy opencode stub", async () => {
    test.fixme(!!gateProbeError, gateProbeError)
    expect(await fixtureOpencodeRequests(fixture!.info.backendUrl)).toEqual([])
  })
})

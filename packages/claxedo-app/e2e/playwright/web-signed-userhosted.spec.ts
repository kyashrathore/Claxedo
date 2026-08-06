/**
 * SPEC: web lane — signed, user-hosted workspace, through the real relay
 * (`docs/plans/2026-08-06-001-test-full-matrix-real-e2e-plan.md`, Phase 4)
 *
 * PURPOSE — the plan's lane x scenario matrix (line 158) assigns this lane
 * A2-A3, all of B, C1/C4, D1-D2, E1, and F2 ("user-hosted: connect through
 * real relay + host tunnel; B-group passes"). This is a THIN CONFIGURATION
 * WRAPPER: every scenario body lives once in `e2e/helpers/web-signed-relay-
 * journeys.ts`, shared verbatim with `web-signed-cloud.spec.ts` (the only
 * axis that differs between the two lanes is `access: "cloud"` vs
 * `"user-hosted"` on the shared fixture). This file owns only: booting that
 * fixture with the right access mode, building and serving the REAL
 * production web bundle against it, and wiring each plan scenario id to its
 * shared journey function.
 *
 * WHAT IS REAL HERE, per owner decision 1 ("no only thing that needs to be
 * stubbed is harness called ai endpoint nothing else stubbed") — the built
 * production web app (see `web-signed-relay-harness.ts`'s file header for the
 * `vite build && vite preview` mechanics and why this closes the "dev server,
 * not a build" deviation `real-cloud-relay.spec.ts`/`live-user-hosted-
 * relay.spec.ts` recorded), the real `hosted-node` control plane on
 * `createSqliteCentralStore` behind `customVerifierAuthAdapter` (plan Phase
 * 3), a real `@claxedo/workspace-relay` process (real EdDSA JWT mint/verify),
 * a real host tunnel (`startUserHostedWorkspaceTunnel`), and the real
 * embedded workspace-runtime engine the tunnel's target resolves to
 * (`user-hosted-tunnel.ts`'s `tunnelTarget`, non-cloud branch ->
 * `workspaceSupervisorServerUrl()`). The ONE fake is the model HTTP endpoint
 * (`scripted-model-server.ts`) — wired into THIS fixture's own process env
 * (`OPENCODE_CONFIG_CONTENT` + `claudeScriptedEnv`), which is new relative to
 * `live-user-hosted-relay.spec.ts`'s fixture: that spec's behavior 3
 * (`test.fixme`) was blocked specifically because "no provider credentials
 * ... are configured for packages/claxedo-server in this environment" — this
 * lane closes exactly that gap, so the scenarios below can complete REAL
 * turns rather than stopping at the connect gate.
 *
 * ROUTING PREMISE, inherited from `live-user-hosted-relay.spec.ts`'s own
 * finding (its HARNESS NOTES "draft composer workspace-target ambiguity",
 * marked FIXED 2026-07-20 via `resolveDraftWorkspaceKind`/`routeWorkspaceKind`
 * in `src/features/session/ui/{view-state,session-screen}.tsx`): a draft
 * navigation to `/w/:workspaceId/session` for a `ws_`-shaped id now carries
 * the ref's real resolved `kind` through instead of collapsing every relay-
 * backed ref into "cloud". That fix is what makes this lane's B-group
 * reachable at all — verified empirically below, not assumed.
 *
 * HARNESS NOTES —
 *   - Fixed backend/preview ports (4537/4539, overridable by env), not
 *     `freePort()` — see `web-signed-relay-harness.ts`'s file header for why
 *     a build needs its backend URL known before it starts, and the plan's
 *     Phase 4 "distinct port block per lane" requirement this satisfies.
 *   - `CLAXEDO_E2E_RELAY_FIXTURE_ACCESS` is left UNSET on this fixture spawn
 *     (the fixture's own default resolves to "user-hosted") — see
 *     `startSignedRelayFixture`'s doc for why omitting the key, not setting
 *     it to a falsy string, is the unambiguous way to select the fixture's
 *     non-cloud branch.
 */
import { expect, test } from "@playwright/test"
import path from "node:path"
import {
  buildAndServeWebApp,
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
const SPEC = "web-signed-userhosted"
const APP_DIR = path.resolve(import.meta.dirname, "..", "..")
const BACKEND_PORT = Number(process.env.CLAXEDO_WEB_SIGNED_USERHOSTED_BACKEND_PORT ?? 4537)
const PREVIEW_PORT = Number(process.env.CLAXEDO_WEB_SIGNED_USERHOSTED_PREVIEW_PORT ?? 4539)
const OUT_DIR = path.join(APP_DIR, "dist-e2e-web-signed-userhosted")

let scripted: ScriptedModelServer | undefined
let fixture: RunningRelayFixture | undefined
let webApp: RunningWebApp | undefined
let forbiddenHits: string[] = []

function ctx(): JourneyCtx {
  return { page: undefined as never, frontendUrl: webApp!.url, info: fixture!.info, scripted: scripted!, spec: SPEC, kind: "user-hosted" }
}

// `@core` is REQUIRED (a spec with no lane tag runs in NO lane, per
// `playwright.config.ts`'s registry comment and `e2e-suite-tags.guard.test.ts`).
// `@tier-real` carves this out of the sharded core run into its own CI job —
// this lane boots its own dedicated backend+relay+build, so it cannot ride a
// shard's shared :3001/:4455 dev server the way `@core`-only specs do.
// `@surface-web` selects this lane by surface, orthogonal to `@tier-real`.
test.describe("web signed user-hosted @core @tier-real @surface-web", () => {
  test.skip(
    !TIER_REAL,
    "Tier R: set CLAXEDO_TIER_REAL_E2E=1 to run web-signed-userhosted against a real relay process, a real host " +
      "tunnel, the real hosted-node control plane, and a REAL BUILT production web bundle (see this file's HARNESS " +
      "NOTES). Unset -> loud, visible skip per e2e/INVARIANTS.md rule 6, never a silent no-op.",
  )

  test.beforeAll(async () => {
    if (!TIER_REAL) return
    test.setTimeout(180_000)
    scripted = await startScriptedModelServer()
    fixture = await startSignedRelayFixture({
      access: "user-hosted",
      backendPort: BACKEND_PORT,
      scripted,
      claudeConfigDir: path.join(APP_DIR, "..", "..", "node_modules", ".cache", "web-signed-userhosted-claude"),
    })
    webApp = await buildAndServeWebApp({ backendUrl: fixture.info.backendUrl, outDir: OUT_DIR, previewPort: PREVIEW_PORT })
  })

  test.afterAll(async () => {
    if (!TIER_REAL) return
    // F2's negative-space half (mirrors `live-user-hosted-relay.spec.ts`
    // behavior 8): across the WHOLE run, nothing addressed a bare/root path
    // at the fixture's own backend origin — every real call this lane made
    // went through `/workspaces/:id/...`, never the pre-relay convention.
    expect(forbiddenHits, `forbidden direct-path requests observed: ${JSON.stringify(forbiddenHits)}`).toEqual([])
    await webApp?.close()
    await fixture?.close()
    await scripted?.close()
  })

  test.beforeEach(async ({ page }) => {
    if (!TIER_REAL) return
    test.setTimeout(180_000)
    forbiddenHits.push(...watchForbiddenDirectRequests(page, new URL(fixture!.info.backendUrl).origin))
  })

  // DIAGNOSTIC, permanent: a failure in any scenario above is otherwise a
  // client-side Playwright error with no visibility into what the shared
  // fixture process (real relay + real embedded engine) was doing at the
  // same moment — every prior spec in this family (`real-cloud-relay.spec
  // .ts`, `live-user-hosted-relay.spec.ts`) accumulates this same `log()`
  // but only surfaces it in a startup GATING throw, never on a mid-test
  // failure. Printing the tail here costs nothing on green runs.
  test.afterEach(async ({}, testInfo) => {
    if (!TIER_REAL || testInfo.status === testInfo.expectedStatus) return
    console.log(`\n[web-signed-userhosted] fixture log tail after "${testInfo.title}" (${testInfo.status}):\n${fixture?.log().slice(-4000)}`)
  })

  test("A2: reload mid-session still renders the transcript and completes a further turn", async ({ page }) => {
    await journeyA2({ ...ctx(), page })
  })

  test("A3: a cold deep link /w/<ws>/session/<id> loads that session", async ({ page }) => {
    await journeyA3({ ...ctx(), page })
  })

  test("B1/B2/B3/B4: a new session's row appears live, completes a turn, auto-titles, and accepts a second message", async ({
    page,
  }) => {
    await journeyB1toB4({ ...ctx(), page })
  })

  test("B5/B6: re-prompting an older row bumps it to the top, and its row stays unique", async ({ page }) => {
    test.setTimeout(150_000)
    await journeyB5B6({ ...ctx(), page })
  })

  test("B7: the background status dot transitions working -> done on a row mounted while idle and never focused", async ({
    page,
  }) => {
    await journeyB7({ ...ctx(), page })
  })

  test("B8: reload preserves rail title, order, and status", async ({ page }) => {
    await journeyB8({ ...ctx(), page })
  })

  test("B9: sidebar and compact-switcher status dots agree, including a transition on an already-mounted tab", async ({
    page,
  }) => {
    await journeyB9({ ...ctx(), page })
  })

  test("C1: a new draft resolves harness/model within 5s with no reload needed", async ({ page }) => {
    await journeyC1({ ...ctx(), page })
  })

  test("C4: switching harness survives a reload and completes a second turn", async ({ page }) => {
    test.setTimeout(180_000)
    await journeyC4({ ...ctx(), page })
  })

  test("D1/D2/D3/E1: a real terminal streams a live prompt and its row aligns with session rows", async ({ page }) => {
    test.setTimeout(120_000)
    await journeyD1toD3E1({ ...ctx(), page })
  })

  test("F2: nothing in the journey ever hit the fixture's forbidden legacy opencode stub", async () => {
    // Behavior mirrors `live-user-hosted-relay.spec.ts` behavior 8's first
    // half: run only after the B/C/D scenarios above have already exercised
    // real traffic through this same fixture — the forbidden stub in
    // `signed-browser-relay-fixture.mjs` only serves a request that bypassed
    // the relay/tunnel entirely, so a non-empty result here means SOME
    // scenario above silently routed around the transport this lane exists
    // to prove.
    expect(await fixtureOpencodeRequests(fixture!.info.backendUrl)).toEqual([])
  })
})

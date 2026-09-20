/**
 * Web lane: signed, a workspace on an enrolled machine, through the real relay.
 *
 * Thin configuration wrapper: every scenario body lives in
 * `e2e/helpers/web-signed-relay-journeys.ts`, shared with
 * `web-signed-cloud.spec.ts`; the only axis that differs is the backing. This
 * file boots the shared fixture with `backing: "local-worktree"`, builds and
 * serves the production web bundle against it, and wires each scenario id to
 * its journey. Test titles
 * carry the ids of the scenario matrix shared with the `desktop-*` lanes
 * (A = shell integrity, B = session lifecycle & rail, C = composer & harness,
 * D = terminal, E = rail geometry).
 *
 * Real: the built web app (`web-signed-relay-harness.ts`), the `hosted-node`
 * control plane on `createSqliteCentralStore` behind
 * `customVerifierAuthAdapter`, a `@claxedo/workspace-relay` process (EdDSA
 * JWT mint/verify), a host tunnel (`startWorkspaceHostTunnel`) and the
 * embedded workspace-runtime engine it resolves to (`host-tunnel.ts`'s
 * `tunnelTarget`). The only fake is the model HTTP endpoint
 * (`scripted-model-server.ts`), wired into the fixture's own process env so
 * the scenarios complete real turns.
 *
 * A draft navigation to `/w/:workspaceId/session` carries the ref's resolved
 * `kind` (`resolveDraftHostKind`/`routeHostKind` in
 * `src/features/session/ui/{view-state,session-screen}.tsx`) instead of
 * treating every relay-backed ref as cloud; the B group depends on that.
 *
 * Fixed backend/preview ports (4537/4539, overridable by env): a build needs
 * its backend URL before it starts, and each signed lane has its own port
 * block. `CLAXEDO_E2E_RELAY_FIXTURE_BACKING` is left unset: the fixture's
 * default is a `local-worktree` placement, and omitting the key (not a falsy
 * string) is what selects it.
 */
import { expect, test, type Page } from "@playwright/test"
import path from "node:path"
import {
  buildAndServeWebApp,
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
const SPEC = "web-signed-host-tunnel"
const APP_DIR = path.resolve(import.meta.dirname, "..", "..")
const BACKEND_PORT = Number(process.env.CLAXEDO_WEB_SIGNED_USERHOSTED_BACKEND_PORT ?? 4537)
const PREVIEW_PORT = Number(process.env.CLAXEDO_WEB_SIGNED_USERHOSTED_PREVIEW_PORT ?? 4539)
const OUT_DIR = path.join(APP_DIR, "dist-e2e-web-signed-host-tunnel")

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
    backing: "local-worktree",
  }
}

// `@core` is required: an untagged spec runs in no lane. `@tier-real` carves
// this out of the sharded core run into its own CI job; the lane boots its own
// backend+relay+build and cannot ride a shard's shared dev server.
// `@surface-web` selects by surface.
test.describe("web signed host tunnel @core @tier-real @surface-web", () => {
  test.skip(
    !TIER_REAL,
    "Tier R: set CLAXEDO_TIER_REAL_E2E=1 to run web-signed-host-tunnel against a real relay process, a real host " +
      "tunnel, the real hosted-node control plane, and a built production web bundle.",
  )

  test.beforeAll(async () => {
    if (!TIER_REAL) return
    test.setTimeout(180_000)
    scripted = await startScriptedModelServer()
    fixture = await startSignedRelayFixture({
      backing: "local-worktree",
      backendPort: BACKEND_PORT,
      browserUrl: `http://app.localhost:${PREVIEW_PORT}`,
      scripted,
      claudeConfigDir: path.join(APP_DIR, "..", "..", "node_modules", ".cache", "web-signed-host-tunnel-claude"),
    })
    webApp = await buildAndServeWebApp({
      backendUrl: fixture.info.backendUrl,
      relayUrl: fixture.info.relayUrl,
      outDir: OUT_DIR,
      previewPort: PREVIEW_PORT,
    })
  })

  test.afterAll(async () => {
    if (!TIER_REAL) return
    try {
      // Across the whole run nothing addressed a bare path at the backend
      // origin; every call went through `/workspaces/:id/...`.
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

  // DIAGNOSTIC, permanent: a failure in any scenario above is otherwise a
  // client-side Playwright error with no visibility into what the shared
  // fixture process (real relay + real embedded engine) was doing at the
  // same moment — every prior spec in this family (`real-cloud-relay.spec
  // .ts`, `live-host-tunnel-relay.spec.ts`) accumulates this same `log()`
  // but only surfaces it in a startup GATING throw, never on a mid-test
  // failure. Printing the tail here costs nothing on green runs.
  test.afterEach(async () => {
    const testInfo = test.info()
    if (!TIER_REAL || testInfo.status === testInfo.expectedStatus) return
    console.log(
      `\n[web-signed-host-tunnel] fixture log tail after "${testInfo.title}" (${testInfo.status}):\n${fixture?.log().slice(-4000)}`,
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

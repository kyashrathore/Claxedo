/**
 * The relay hop itself. `web-signed-cloud.spec.ts` proves the product journeys for a cloud
 * workspace over the same fixture; this file proves what that lane cannot observe — that
 * the relay is in the path (the fixture's forward counter and the scripted endpoint's
 * counts agree), that nothing bypassed it to a bare runtime path, and that breaking the far
 * side of the hop makes a turn fail loudly while resuming restores service without a fresh
 * process.
 *
 * Real here: the built production web bundle served through the fixture gateway
 * (`buildAndServeWebApp` in web-signed-relay-harness.ts), the `hosted-node` control plane on
 * `customVerifierAuthAdapter`, a `@claxedo/workspace-relay` process, and the in-process
 * cloud workspace-runtime (`startCloudRuntime` in signed-browser-relay-fixture.mjs). The
 * model HTTP endpoint is the only fake.
 *
 * The browser authenticates by cookie, the way the product's better-auth adapter does; the
 * fixture gateway (`fixture-web-preview.mjs`) turns that HttpOnly cookie into the bearer the
 * control plane verifies and stamps the forwarded-client header the signed bootstrap
 * requires. A frontend that does neither 401s every control-plane call and the gate reports
 * the host offline, so this lane must ride the shared harness rather than a plain dev
 * server.
 *
 * Backend and preview ports are fixed at 4547/4549 (env-overridable), distinct from the
 * sibling signed lanes so all four can run serially in one job.
 * `/__fixture/cloud-runtime/{stats,pause,resume}` are fixture-only backend routes reached
 * from this process, never from the page.
 *
 * The forward counter proves the hop reached a runtime the page has no URL for. It does not
 * prove the WebSocket relay tunnel carried it.
 */
import { expect, test, type Page } from "@playwright/test"
import path from "node:path"
import { startScriptedModelServer, type ScriptedModelServer } from "../helpers/scripted-model-server"
import { expectAssistantReplyVisible, SELECTORS } from "../helpers/turn-oracle"
import { expectLiveTurnsSettledAfterReload, expectLiveUserRowCount } from "../helpers/turn-oracle-extras"
import {
  APP_DIR,
  buildAndServeWebApp,
  composeText,
  composerInput,
  gateReachesReady,
  seedWorkspace,
  selectScriptedModel,
  sendSubsequentMessage,
  sessionRoute,
  startSignedRelayFixture,
  submitControl,
  submitDraft,
  type RunningRelayFixture,
  type RunningWebApp,
} from "../helpers/web-signed-relay-harness"
import { watchForbiddenDirectRequests } from "../helpers/web-signed-relay-journeys"

const TIER_REAL = process.env.CLAXEDO_TIER_REAL_E2E === "1"
const SPEC = "real-cloud-relay"
const BACKEND_PORT = Number(process.env.CLAXEDO_REAL_CLOUD_RELAY_BACKEND_PORT ?? 4547)
const PREVIEW_PORT = Number(process.env.CLAXEDO_REAL_CLOUD_RELAY_PREVIEW_PORT ?? 4549)
const OUT_DIR = path.join(APP_DIR, "dist-e2e-real-cloud-relay")

let scripted: ScriptedModelServer | undefined
let fixture: RunningRelayFixture | undefined
let webApp: RunningWebApp | undefined
let forbiddenHits: string[] = []

async function fixtureJson<T>(pathname: string, method: "GET" | "POST" = "GET"): Promise<T> {
  const res = await fetch(`${fixture!.info.backendUrl}${pathname}`, { method })
  if (!res.ok) throw new Error(`GATING: ${method} ${pathname} failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

const cloudRuntimeStats = () => fixtureJson<{ forwarded: number; paused: boolean }>("/__fixture/cloud-runtime/stats")
const pauseCloudRuntime = () => fixtureJson<{ paused: boolean }>("/__fixture/cloud-runtime/pause", "POST")
const resumeCloudRuntime = () => fixtureJson<{ resumed: boolean }>("/__fixture/cloud-runtime/resume", "POST")

function promptText(marker: string) {
  return `Reply with exactly this one token and nothing else, no punctuation, no formatting: ${marker}`
}

/** Opens the workspace draft route through the connect gate; every scenario's entry point. */
async function openReadyWorkspace(page: Page) {
  await seedWorkspace(page, fixture!.info, "cloud-vm")
  await page.goto(`${webApp!.url}${sessionRoute(fixture!.info)}`, { waitUntil: "domcontentloaded", timeout: 45_000 })
  await gateReachesReady(page)
}

/** First send on a fresh draft: the scripted model is selected, and the authoritative 201 is awaited. */
async function sendFirstPrompt(page: Page, marker: string) {
  await composeText(page, composerInput(page), promptText(marker))
  await selectScriptedModel(page)
  return await submitDraft(page)
}

/** A later send inside the session the first prompt opened. */
async function sendNextPrompt(page: Page, marker: string) {
  await composeText(page, composerInput(page), promptText(marker))
  await sendSubsequentMessage(page)
}

test.describe("real cloud relay @core @tier-real", () => {
  test.skip(
    !TIER_REAL,
    "Tier R: set CLAXEDO_TIER_REAL_E2E=1 to run real-cloud-relay against a real relay process, real EdDSA JWTs, a " +
      "real in-process cloud workspace-runtime and a real built production web bundle, with only the model endpoint " +
      "scripted. This lane boots its own backend and gateway, so it cannot ride a sharded core run. Unset -> loud, " +
      "visible skip, never a silent no-op.",
  )

  test.beforeAll(async () => {
    if (!TIER_REAL) return
    test.setTimeout(180_000)
    scripted = await startScriptedModelServer()
    fixture = await startSignedRelayFixture({
      backing: "cloud-vm",
      backendPort: BACKEND_PORT,
      browserUrl: `http://app.localhost:${PREVIEW_PORT}`,
      scripted,
      claudeConfigDir: path.join(APP_DIR, "..", "..", "node_modules", ".cache", "real-cloud-relay-claude"),
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
      // Across the whole run: nothing addressed a bare runtime path at the backend origin,
      // so every runtime request went through the relay.
      expect(forbiddenHits, `forbidden direct-path requests observed: ${JSON.stringify(forbiddenHits)}`).toEqual([])
    } finally {
      await Promise.allSettled([webApp?.close(), fixture?.close(), scripted?.close()])
    }
  })

  test.beforeEach(async ({ page }, testInfo) => {
    if (!TIER_REAL) return
    // Real relay + real engine boot: the first turn pays a genuine multi-second
    // cost that a mocked lane never sees.
    testInfo.setTimeout(300_000)
    scripted!.resetCounts()
    watchForbiddenDirectRequests(page, new URL(fixture!.info.backendUrl).origin, forbiddenHits)
  })

  // A client-side Playwright error cannot show why the fixture refused something, so the
  // fixture's own log tail is surfaced on any non-green result.
  test.afterEach(async () => {
    const testInfo = test.info()
    if (!TIER_REAL || testInfo.status === testInfo.expectedStatus) return
    console.log(
      `\n[${SPEC}] fixture log tail after "${testInfo.title}" (${testInfo.status}):\n${fixture?.log().slice(-4000)}`,
    )
  })

  test("a cloud workspace completes real turns across the relay and survives reload", async ({
    page,
  }) => {
    await openReadyWorkspace(page)

    const runId = `${Date.now()}`.slice(-6)
    const markers = [`CLOUD-${runId}-T1`, `CLOUD-${runId}-T2`]

    await sendFirstPrompt(page, markers[0])
    await expectAssistantReplyVisible(page, new RegExp(markers[0]), { spec: SPEC, scenario: "turn-1" })

    await sendNextPrompt(page, markers[1])
    await expectAssistantReplyVisible(page, new RegExp(markers[1]), { spec: SPEC, scenario: "turn-2" })
    await expectLiveUserRowCount(page, markers.length)

    // Read back across the relay from the cloud runtime's own store.
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 60_000 })
    await expectAssistantReplyVisible(page, new RegExp(markers[1]), { spec: SPEC, scenario: "reload" })
    await expectLiveTurnsSettledAfterReload(page, markers)

    // Both halves matter: the forward counter proves the relay reached a runtime the page
    // has no URL for, the scripted counts prove the model call happened behind it. Either
    // alone could be satisfied by a shortcut.
    const stats = await cloudRuntimeStats()
    expect(
      stats.forwarded,
      "expected the relay to have forwarded requests to the cloud runtime — zero means the turn was served by " +
        "something the page could reach directly, so the relay was not in the path at all",
    ).toBeGreaterThan(0)
    const counts = scripted!.counts()
    expect(
      counts.responses,
      `expected the scripted endpoint to carry both turns from behind the relay, saw ${JSON.stringify(counts)}`,
    ).toBeGreaterThanOrEqual(markers.length)

    // Nothing addressed a bare runtime path at the backend origin instead of
    // /workspaces/:id/… , which would be a relay bypass.
    expect(forbiddenHits).toEqual([])
  })

  test("pausing the far side of the relay hop makes a turn fail, and resuming restores it", async ({
    page,
  }) => {
    await openReadyWorkspace(page)

    const runId = `${Date.now()}`.slice(-6)
    const healthyMarker = `CLOUDOK-${runId}`
    await sendFirstPrompt(page, healthyMarker)
    await expectAssistantReplyVisible(page, new RegExp(healthyMarker), { spec: SPEC, scenario: "before-pause" })

    // Break the far side of the hop. Everything else — page, backend, relay
    // process, scripted endpoint — stays exactly as it was, so a failure after
    // this point is attributable to the transport and nothing else.
    await pauseCloudRuntime()
    expect((await cloudRuntimeStats()).paused).toBe(true)

    const beforePaused = scripted!.counts().responses
    const forwardedBefore = (await cloudRuntimeStats()).forwarded
    const pausedMarker = `CLOUDDOWN-${runId}`
    try {
      // Await the actual failed dispatch before asserting absence of a reply.
      // A zero-count locator succeeds immediately; its timeout is not a quiet window.
      await composeText(page, composerInput(page), promptText(pausedMarker))
      const submit = submitControl(page)
      await expect(submit).toBeEnabled({ timeout: 10_000 })
      const [response] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/prompt_async"),
          { timeout: 20_000 },
        ),
        submit.click(),
      ])
      expect(response.status()).toBe(503)
      expect(await response.json()).toMatchObject({ error: { code: "cloud_runtime_paused" } })
      // The request reached the relay's far side and was refused there: the fixture counted
      // the forward, and the model behind it was never called.
      expect((await cloudRuntimeStats()).forwarded).toBeGreaterThan(forwardedBefore)
      await expect(page.locator(SELECTORS.assistantContent).filter({ hasText: pausedMarker })).toHaveCount(0)
      expect(scripted!.counts().responses).toBe(beforePaused)
    } finally {
      await resumeCloudRuntime()
    }

    // Resume and prove the fixture still works, so the failure above was the
    // pause and not a one-way break.
    expect((await cloudRuntimeStats()).paused).toBe(false)
    await page.reload({ waitUntil: "domcontentloaded" })
    await gateReachesReady(page)
    const recoveredMarker = `CLOUDBACK-${runId}`
    await sendNextPrompt(page, recoveredMarker)
    await expectAssistantReplyVisible(page, new RegExp(recoveredMarker), { spec: SPEC, scenario: "after-resume" })
  })
})

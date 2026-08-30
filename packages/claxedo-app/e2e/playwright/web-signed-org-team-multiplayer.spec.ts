/**
 * SPEC: Org → Team multiplayer proof against the REAL production web bundle
 * and the real signed self-hosted control plane (SQLite WorkspaceAuthority).
 *
 * REAL (not mocked): production Vite build, createSelfHostedApp, JWT control-plane
 * auth, org/team/share/session HTTP, embedded workspace-runtime + relay, multi-browser
 * Playwright, People UI, composer drive path.
 *
 * FIXTURE / substitute: local JWKS teammate mint (not Clerk staging), page token seed
 * (not OAuth redirect), scripted model server (not live Claude/Codex), collaborative
 * org bootstrap via CLAXEDO_E2E_COLLABORATIVE_ORG_NAME.
 *
 * Canonical journey (video required):
 * add Bob to default team → open Bob on workspace → Alice private session →
 * Bob denied on rail → Alice People shares with team → Bob's rail gets the
 * session via live fanout (no reload) with Alice owner favicon → Bob views/drives →
 * Casey still denied → revoke → Bob denied.
 *
 * Known follow-up (not asserted here): when Bob starts a *new* session in this
 * shared project he still has no local directory mapping and must pick one.
 *
 * Replaces `web-signed-two-user.spec.ts` (participant-only was a subset of this path).
 */
import { expect, test } from "@playwright/test"
import { mkdirSync } from "node:fs"
import path from "node:path"
import {
  buildAndServeWebApp,
  composeText,
  composerInput,
  gateReachesReady,
  selectScriptedModel,
  sendSubsequentMessage,
  startSignedRelayFixture,
  submitDraft,
  waitForWorkspaceRole,
  type RunningRelayFixture,
  type RunningWebApp,
  type SignedRelayAccess,
} from "../helpers/web-signed-relay-harness"
import {
  addTeamMember,
  composeSideBySideVideo,
  controlMessages,
  controlSessions,
  expectAuthorVisible,
  expectNoSessionOwnerAvatar,
  expectRailAccountName,
  expectSessionOwnerAvatar,
  listSessionShares,
  listTeamMembers,
  mintTeammate,
  openAs,
  openRecordedPage,
  persistVideoCopy,
  revokeSessionShareTeam,
  sessionIdsOnRail,
  shareSessionWithTeamViaPeopleUi,
  waitForModelsReady,
  writeEvidenceManifest,
  type Teammate,
} from "../helpers/web-signed-multiplayer-helpers"
import { SELECTORS as RAIL_SELECTORS } from "../helpers/rail-oracle"
import { expectAssistantReplyVisible } from "../helpers/turn-oracle"
import { startScriptedModelServer, type ScriptedModelServer } from "../helpers/scripted-model-server"

const TIER_REAL = process.env.CLAXEDO_TIER_REAL_E2E === "1"
const SPEC = "web-signed-org-team-multiplayer"
const APP_DIR = path.resolve(import.meta.dirname, "..", "..")
const ACCESS: SignedRelayAccess = (process.env.CLAXEDO_WEB_SIGNED_ORG_TEAM_ACCESS as SignedRelayAccess) || "user-hosted"
const BACKEND_PORT = Number(process.env.CLAXEDO_WEB_SIGNED_ORG_TEAM_BACKEND_PORT ?? 4557)
const PREVIEW_PORT = Number(process.env.CLAXEDO_WEB_SIGNED_ORG_TEAM_PREVIEW_PORT ?? 4559)
const OUT_DIR = path.join(APP_DIR, "dist-e2e-web-signed-org-team-multiplayer")
const VIDEO_ROOT = process.env.CLAXEDO_ORG_TEAM_VIDEO_DIR
  || path.join(APP_DIR, "test-results/evidence", SPEC, "videos")
const EVIDENCE_DIR = path.join(APP_DIR, "test-results/evidence", SPEC)
const ALICE_NAME = "Alice"
const BOB_NAME = "Bob"
const CASEY_NAME = "Casey"
const ORG_NAME = "Acme Multiplayer"

let scripted: ScriptedModelServer | undefined
let fixture: RunningRelayFixture | undefined
let webApp: RunningWebApp | undefined
let bob: Teammate | undefined
let casey: Teammate | undefined

test.describe("web signed org-team multiplayer @core @tier-real @surface-web", () => {
  test.skip(
    !TIER_REAL,
    "Tier R: set CLAXEDO_TIER_REAL_E2E=1 to walk Alice/Bob/Casey Org→Team multiplayer against the real signed app.",
  )

  test.beforeAll(async () => {
    if (!TIER_REAL) return
    test.setTimeout(360_000)
    scripted = await startScriptedModelServer()
    fixture = await startSignedRelayFixture({
      access: ACCESS,
      backendPort: BACKEND_PORT,
      scripted,
      collaborativeOrg: { name: ORG_NAME },
      claudeConfigDir: path.join(APP_DIR, "..", "..", "node_modules", ".cache", "web-signed-org-team-claude"),
      extraEnv: { CLAXEDO_E2E_OWNER_DISPLAY_NAME: ALICE_NAME },
    })
    expect(fixture.info.orgId, "collaborative fixture must publish orgId").toBeTruthy()
    expect(fixture.info.orgId).not.toBe("personal")
    expect(fixture.info.defaultTeamId, "collaborative fixture must publish defaultTeamId").toBeTruthy()

    webApp = await buildAndServeWebApp({
      backendUrl: fixture.info.backendUrl,
      outDir: OUT_DIR,
      previewPort: PREVIEW_PORT,
    })

    bob = await mintTeammate(fixture, "user_bob", "editor", {
      name: BOB_NAME,
      // Team membership unlocks the session share; workspace share mirrors a
      // teammate who already has workspace authority via team project grants.
      grantWorkspaceShare: true,
    })
    casey = await mintTeammate(fixture, "user_casey", "editor", {
      name: CASEY_NAME,
      grantWorkspaceShare: true,
    })

    await addTeamMember(fixture, webApp, fixture.info.defaultTeamId!, bob.tokenIdentifier)
    const members = await listTeamMembers(fixture, webApp, fixture.info.defaultTeamId!)
    expect(
      members.some((row) => row.token_identifier === bob!.tokenIdentifier || row.user_id === bob!.tokenIdentifier),
      "Bob must appear on the default team",
    ).toBe(true)
  })

  test.afterAll(async () => {
    if (!TIER_REAL) return
    await Promise.allSettled([webApp?.close(), fixture?.close(), scripted?.close()])
  })

  test("team member + People team share + view/drive + revoke — records proof video", async ({ browser }) => {
    test.setTimeout(360_000)
    mkdirSync(VIDEO_ROOT, { recursive: true })
    mkdirSync(EVIDENCE_DIR, { recursive: true })

    const aliceCtx = await openRecordedPage(browser, path.join(VIDEO_ROOT, "alice-raw"))
    const bobCtx = await openRecordedPage(browser, path.join(VIDEO_ROOT, "bob-raw"))
    const caseyCtx = await openRecordedPage(browser, path.join(VIDEO_ROOT, "casey-raw"))

    const marker = `OT_${Date.now().toString(36)}`
    const alicePrompt = `please reply with exactly this one token, nothing else: ${marker}_ALICE`
    const bobPrompt = `please reply with exactly this one token, nothing else: ${marker}_BOB`

    let aliceVideoPath: string | undefined
    let bobVideoPath: string | undefined
    let caseyVideoPath: string | undefined
    let sessionId = ""

    try {
      await openAs(
        aliceCtx.page,
        fixture!,
        webApp!,
        ACCESS,
        fixture!.info.controlPlaneToken,
        { id: "user_browser", fullName: ALICE_NAME },
      )
      await expectRailAccountName(aliceCtx.page, ALICE_NAME)

      // Create a real private session turn now that relay→host RAT/RHT actor
      // resolution is fixed (session create was 503 before).
      scripted!.resetCounts()
      await composeText(aliceCtx.page, composerInput(aliceCtx.page), alicePrompt)
      await selectScriptedModel(aliceCtx.page)
      sessionId = await submitDraft(aliceCtx.page)
      expect(sessionId, "Alice must mint a real session id").toBeTruthy()
      await expectAssistantReplyVisible(aliceCtx.page, new RegExp(`${marker}_ALICE`), {
        spec: SPEC,
        scenario: "org-team-alice-create",
        timeout: 60_000,
      })
      await expectAuthorVisible(aliceCtx.page, ALICE_NAME)
      await expectNoSessionOwnerAvatar(aliceCtx.page, sessionId)
      await aliceCtx.page.screenshot({ path: path.join(EVIDENCE_DIR, "alice-private-session.png"), fullPage: true })

      // Bob is already on the workspace before share so fanout (not navigation)
      // is what surfaces the session row.
      await openAs(bobCtx.page, fixture!, webApp!, ACCESS, bob!.controlPlaneToken, {
        id: "user_bob",
        fullName: BOB_NAME,
      }, "editor")
      await expectRailAccountName(bobCtx.page, BOB_NAME)
      expect(
        await sessionIdsOnRail(bobCtx.page),
        "Bob must not see the private session on the rail before team share",
      ).not.toContain(sessionId)

      expect(await controlSessions(fixture!, webApp!, fixture!.info.controlPlaneToken)).toContain(sessionId)
      expect(
        await controlSessions(fixture!, webApp!, bob!.controlPlaneToken),
        "Bob must not list the private session before team share",
      ).not.toContain(sessionId)
      expect(
        await controlSessions(fixture!, webApp!, casey!.controlPlaneToken),
        "Casey must not list the private session",
      ).not.toContain(sessionId)
      expect(await controlMessages(fixture!, webApp!, bob!.controlPlaneToken, sessionId)).toMatchObject({
        allowed: false,
        messages: [],
      })
      expect(await controlMessages(fixture!, webApp!, casey!.controlPlaneToken, sessionId)).toMatchObject({
        allowed: false,
        messages: [],
      })

      // People UI is the product share path (titlebar-right slot on workbench header).
      await shareSessionWithTeamViaPeopleUi(aliceCtx.page, fixture!.info.defaultTeamId!)
      const shares = await listSessionShares(fixture!, webApp!, sessionId)
      expect(
        (shares.grants ?? []).some((grant) => grant.granted_to_team_id === fixture!.info.defaultTeamId),
        "control-plane share list must include the default team grant",
      ).toBe(true)

      expect(await controlSessions(fixture!, webApp!, bob!.controlPlaneToken)).toContain(sessionId)
      expect(await controlMessages(fixture!, webApp!, bob!.controlPlaneToken, sessionId)).toMatchObject({
        allowed: true,
      })
      expect(await controlSessions(fixture!, webApp!, casey!.controlPlaneToken)).not.toContain(sessionId)
      expect(await controlMessages(fixture!, webApp!, casey!.controlPlaneToken, sessionId)).toMatchObject({
        allowed: false,
        messages: [],
      })

      // Live fanout: Bob stays on the open project — no reload / re-openAs.
      await expect(bobCtx.page.locator(RAIL_SELECTORS.sessionRow(sessionId))).toBeVisible({ timeout: 30_000 })
      await expectSessionOwnerAvatar(bobCtx.page, sessionId, ALICE_NAME)
      await bobCtx.page.screenshot({ path: path.join(EVIDENCE_DIR, "bob-fanout-project-open.png"), fullPage: true })

      // Project not in focus: leave the workspace, then return — session + Alice
      // favicon must still be on the rail without Alice re-sharing.
      await bobCtx.page.goto(webApp!.url + "/", { waitUntil: "domcontentloaded", timeout: 45_000 })
      await gateReachesReady(bobCtx.page).catch(() => undefined)
      await bobCtx.page.goto(`${webApp!.url}/w/${encodeURIComponent(fixture!.info.workspaceId)}/session`, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      })
      await gateReachesReady(bobCtx.page)
      await waitForWorkspaceRole(bobCtx.page, fixture!.info.workspaceId, "editor")
      await expect(bobCtx.page.locator(RAIL_SELECTORS.sessionRow(sessionId))).toBeVisible({ timeout: 30_000 })
      await expectSessionOwnerAvatar(bobCtx.page, sessionId, ALICE_NAME)
      await bobCtx.page.screenshot({ path: path.join(EVIDENCE_DIR, "bob-after-reopen-project.png"), fullPage: true })

      await bobCtx.page.locator(RAIL_SELECTORS.sessionRow(sessionId)).click()
      await waitForModelsReady(bobCtx.page)
      await waitForWorkspaceRole(bobCtx.page, fixture!.info.workspaceId, "editor")
      await expectAssistantReplyVisible(bobCtx.page, new RegExp(`${marker}_ALICE`), {
        spec: SPEC,
        scenario: "org-team-bob-sees-alice",
        timeout: 60_000,
      })
      await bobCtx.page.screenshot({ path: path.join(EVIDENCE_DIR, "bob-after-share.png"), fullPage: true })

      scripted!.resetCounts()
      await composeText(bobCtx.page, composerInput(bobCtx.page), bobPrompt)
      await selectScriptedModel(bobCtx.page)
      await sendSubsequentMessage(bobCtx.page)
      await expectAssistantReplyVisible(bobCtx.page, new RegExp(`${marker}_BOB`), {
        spec: SPEC,
        scenario: "org-team-bob-drive",
        timeout: 60_000,
      })
      await expectAuthorVisible(bobCtx.page, BOB_NAME)
      await bobCtx.page.screenshot({ path: path.join(EVIDENCE_DIR, "bob-drive.png"), fullPage: true })

      await aliceCtx.page.reload({ waitUntil: "domcontentloaded" })
      await gateReachesReady(aliceCtx.page)
      await expect(aliceCtx.page.locator(RAIL_SELECTORS.sessionRow(sessionId))).toBeVisible({ timeout: 20_000 })
      await aliceCtx.page.locator(RAIL_SELECTORS.sessionRow(sessionId)).click()
      await expectAuthorVisible(aliceCtx.page, BOB_NAME)

      await openAs(caseyCtx.page, fixture!, webApp!, ACCESS, casey!.controlPlaneToken, {
        id: "user_casey",
        fullName: CASEY_NAME,
      }, "editor")
      expect.soft(await sessionIdsOnRail(caseyCtx.page)).not.toContain(sessionId)
      await caseyCtx.page.screenshot({ path: path.join(EVIDENCE_DIR, "casey-denied-after.png"), fullPage: true })

      await revokeSessionShareTeam(fixture!, webApp!, sessionId, fixture!.info.defaultTeamId!)
      expect(
        await controlSessions(fixture!, webApp!, bob!.controlPlaneToken),
        "Bob must not list the session on the control plane after revoke",
      ).not.toContain(sessionId)
      expect(await controlMessages(fixture!, webApp!, bob!.controlPlaneToken, sessionId)).toMatchObject({
        allowed: false,
        messages: [],
      })
      // The already-open Bob client must consume the scoped revoke doorbell and
      // revalidate its canonical session inventory. No identity reset or
      // `openAs` is allowed here: that would prove only cold bootstrap denial.
      await expect(bobCtx.page.locator(RAIL_SELECTORS.sessionRow(sessionId))).toHaveCount(0, { timeout: 30_000 })

      // Reload the currently open deep link as the same signed user and
      // observe the request made by the application itself. The canonical
      // navigation producer must remain empty after a cold application read;
      // a route-active shell may still render its last transcript while that
      // deep link is open, but it cannot restore Bob to the session inventory.
      const reloadedSessionList = bobCtx.page.waitForResponse(
        (response) => {
          const url = new URL(response.url())
          return response.request().method() === "GET"
            && url.pathname === "/api/claxedo/session-list"
            && url.searchParams.get("scope") === "project"
            && response.status() === 200
        },
        { timeout: 20_000 },
      )
      await bobCtx.page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 })
      const reloadedList = await (await reloadedSessionList).json() as {
        items?: Array<{ sessionId?: string }>
        groups?: Array<{ items?: Array<{ sessionId?: string }> }>
      }
      expect([
        ...(reloadedList.items ?? []),
        ...(reloadedList.groups ?? []).flatMap((group) => group.items ?? []),
      ].map((item) => item.sessionId)).not.toContain(sessionId)
      await gateReachesReady(bobCtx.page)
      await waitForWorkspaceRole(bobCtx.page, fixture!.info.workspaceId, "editor")
      await bobCtx.page.screenshot({ path: path.join(EVIDENCE_DIR, "bob-after-revoke.png"), fullPage: true })

      await aliceCtx.page.waitForTimeout(2_000)
      await bobCtx.page.waitForTimeout(2_000)
      await caseyCtx.page.waitForTimeout(1_000)

      aliceVideoPath = (await aliceCtx.page.video()?.path()) ?? undefined
      bobVideoPath = (await bobCtx.page.video()?.path()) ?? undefined
      caseyVideoPath = (await caseyCtx.page.video()?.path()) ?? undefined
    } finally {
      await Promise.allSettled([
        aliceCtx.context.close(),
        bobCtx.context.close(),
        caseyCtx.context.close(),
      ])
    }

    const aliceOut = persistVideoCopy(aliceVideoPath, path.join(VIDEO_ROOT, "alice.webm"))
    const bobOut = persistVideoCopy(bobVideoPath, path.join(VIDEO_ROOT, "bob.webm"))
    const caseyOut = persistVideoCopy(caseyVideoPath, path.join(VIDEO_ROOT, "casey.webm"))
    const composed = path.join(VIDEO_ROOT, "side-by-side.mp4")
    await composeSideBySideVideo({ aliceWebm: aliceOut, bobWebm: bobOut, outMp4: composed })

    writeEvidenceManifest(path.join(VIDEO_ROOT, "manifest.json"), {
      spec: SPEC,
      access: ACCESS,
      sessionId,
      orgId: fixture!.info.orgId,
      defaultTeamId: fixture!.info.defaultTeamId,
      workspaceId: fixture!.info.workspaceId,
      alice: { name: ALICE_NAME, video: aliceOut },
      bob: { name: BOB_NAME, video: bobOut },
      casey: { name: CASEY_NAME, video: caseyOut },
      composed,
      evidenceDir: EVIDENCE_DIR,
    })
  })
})

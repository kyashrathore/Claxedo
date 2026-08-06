/**
 * SPEC: desktop lane — signed identity, cloud workspace via the real relay
 * (packaged Electron)
 *
 * PURPOSE — the cloud-workspace cell of the desktop matrix row
 * `desktop-signed-cloud | A1–A2 | all | C1,C4 | D1–D2 | E1 | F3`
 * (`docs/plans/2026-08-06-001-test-full-matrix-real-e2e-plan.md`, Phase 4).
 * Sibling of `desktop-signed-embedded-shared.spec.ts` — same packaged
 * binary, same `desktop-signed-server.ts` harness, `access: "cloud"` instead
 * of `"user-hosted"`, so the fixture stands up a SECOND real in-process
 * workspace-runtime as the cloud sandbox and flips the workspace row to
 * `kind: "cloud"` (`signed-browser-relay-fixture.mjs`'s `startCloudRuntime`).
 * Per owner decision 1, the ONLY permitted fake anywhere in this lane is the
 * AI model HTTP endpoint.
 *
 * *** GATING FINDINGS (2026-08-06) — layered, both load-bearing ***
 *
 * 1. SHARED with `desktop-signed-embedded-shared.spec.ts`: the packaged
 *    desktop build's test-auth bypass is dead code. `testAuth()`
 *    (`src/platform/auth/auth-client.ts:112-176`) requires
 *    `import.meta.env.DEV || MODE==="test" || VITE_CLAXEDO_E2E==="1"`, none
 *    of which `packages/claxedo-desktop`'s always-production `electron-vite
 *    build` ever sets. Proven by extracting the shared `--dir` build's
 *    `app.asar` and finding `function testAuth() { return {}; }` — the
 *    entire bypass body constant-folded away. See that file's header for the
 *    full citation and why rebuilding with `VITE_CLAXEDO_E2E=1` was rejected
 *    here (it would silently overwrite the shared `out/`/`dist/` artifact
 *    Phase 2's own in-progress verification depends on).
 *
 * 2. SPECIFIC to cloud mode, and STRICTLY WORSE than gap 1 — even a lane
 *    that COULD authenticate would still be blocked. `real-cloud-relay.spec.ts`
 *    (the web-lane sibling for this exact `access: "cloud"` fixture mode,
 *    same `signed-browser-relay-fixture.mjs`) is ENTIRELY `test.fixme`d as of
 *    2026-08-06 with this recorded finding: "the cloud connect gate reports
 *    'Workspace startup failed' — `prepareWorkspaceRuntime`'s resolve rejects
 *    an already-ready cloud workspace" (see that file's HARNESS NOTES
 *    "REMAINING BLOCKER"). This is CLIENT-SIDE code
 *    (`workspace-connection.ts` → `prepareWorkspaceRuntime` →
 *    `resolveWorkspaceRuntime`), platform-agnostic — it runs identically in
 *    Electron's Chromium and a browser tab. Even a `VITE_CLAXEDO_E2E=1`
 *    desktop build that closed gap 1 would still hit this SECOND, deeper,
 *    already-diagnosed product bug before any composer/rail/terminal
 *    scenario could be driven. Re-verifying it independently on this surface
 *    was judged not worth the ~2-3 minutes of real fixture+packaged-app boot
 *    per attempt it would cost, given the root cause is already named and is
 *    not desktop-specific — citing it here rather than re-discovering it.
 *
 * WHAT IS REAL HERE — the packaged app, a REAL `signed-browser-relay-
 * fixture.mjs` process in `access: "cloud"` mode (real SQLite authority, real
 * JWKS issuer, a real second workspace-runtime standing in for the cloud
 * sandbox), and a real X-Forwarded-For proxy in front of it
 * (`desktop-signed-server.ts`), so the ONE scenario that can run for real
 * (A1) proves the harness plumbing against the REAL cloud-mode fixture
 * variant, not a shortcut.
 */
import { expect, test } from "@playwright/test"
import { expectServerReachable, launchPackagedApp, type PackagedApp } from "../helpers/electron-app"
import {
  claudeScriptedEnv,
  opencodeScriptedProviderConfig,
  startScriptedModelServer,
} from "../helpers/scripted-model-server"
import {
  seedDesktopSignedWorkspace,
  seedDesktopTestAuth,
  startForwardedForProxy,
  startSignedFixture,
  type SignedFixtureInfo,
} from "../helpers/desktop-signed-server"

const BOOT_TIMEOUT = 90_000

test.describe("desktop signed cloud @core @tier-real @surface-desktop", () => {
  test.skip(
    !process.env.CLAXEDO_E2E_DESKTOP,
    "desktop lane: set CLAXEDO_E2E_DESKTOP=1 and build the packaged app first " +
      "(cd packages/claxedo-desktop && bun run build && npx electron-builder --dir --config electron-builder.config.ts)",
  )

  let fixtureClose: (() => Promise<void>) | undefined
  let proxyClose: (() => Promise<void>) | undefined
  let packaged: PackagedApp | undefined
  let info: SignedFixtureInfo | undefined
  let proxyUrl: string | undefined

  test.beforeAll(async () => {
    if (!process.env.CLAXEDO_E2E_DESKTOP) return
    const fixture = await startSignedFixture({
      access: "cloud",
      claudeScriptedEnv,
      opencodeScriptedProviderConfig,
      startScriptedModelServer,
      logLabel: "desktop-signed-cloud",
    })
    info = fixture.info
    fixtureClose = fixture.close
    const proxy = await startForwardedForProxy(fixture.info.backendUrl)
    proxyUrl = proxy.url
    proxyClose = proxy.close
  })

  test.afterAll(async () => {
    await proxyClose?.()
    await fixtureClose?.()
  })

  test.afterEach(async () => {
    await packaged?.close()
    packaged = undefined
  })

  test.setTimeout(120_000)

  /**
   * A1 — see file header "GATING FINDINGS": the only scenario that needs
   * neither a signed-in principal nor a resolved cloud connect gate.
   * `bootstrap.ts`'s `BootstrapRoutes` returns the LOCAL, unauthenticated 200
   * body whenever no bearer token is present, so an anonymous packaged
   * renderer still gets a real 2xx from the real external `access: "cloud"`
   * fixture. Proves `serverUrl` (`electron-app.ts`) + the real cloud-mode
   * fixture + the real X-Forwarded-For proxy compose correctly.
   */
  test("A1 (diagnostic): the packaged renderer reaches the REAL external signed (cloud-mode) control plane over http(s)", async () => {
    packaged = await launchPackagedApp({ timeoutMs: BOOT_TIMEOUT, serverUrl: proxyUrl })
    const url = await expectServerReachable(packaged, 45_000)
    expect(url).toMatch(/^https?:\/\//)
    expect(new URL(url).origin).toBe(new URL(proxyUrl!).origin)
    const protocol = await packaged.page.evaluate(() => window.location.protocol)
    expect(protocol).toBe("file:")
  })

  /**
   * A2 (reload mid-session) through F3 (cloud via real relay) all need EITHER
   * gap 1 (auth) or gap 2 (the connect gate itself) resolved, and cloud mode
   * is blocked by BOTH — gap 2 alone means even a hypothetically-authenticated
   * run cannot reach "ready" for this workspace kind. `test.fixme`, citing
   * this file's header, not a weakened assertion. `seedDesktopTestAuth`/
   * `seedDesktopSignedWorkspace` are left called (real, `desktop-signed-
   * server.ts`) so un-skipping needs only the journey once both upstream
   * gaps close, not a re-derivation of the seed step.
   */
  test.fixme(
    "A2/B1–B9/C1/C4/D1–D2/E1/F3: everything past bootstrap — GATED, see file header (gaps 1 and 2)",
    async () => {
      packaged = await launchPackagedApp({ timeoutMs: BOOT_TIMEOUT, serverUrl: proxyUrl })
      await seedDesktopTestAuth(packaged.page, info!)
      await seedDesktopSignedWorkspace(packaged.page, info!, "cloud")
    },
  )
})

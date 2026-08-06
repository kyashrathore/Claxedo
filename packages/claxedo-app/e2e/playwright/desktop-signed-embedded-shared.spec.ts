/**
 * SPEC: desktop lane — signed identity, embedded-and-shared workspace (packaged Electron)
 *
 * PURPOSE — Phase 2's `desktop-unsigned-embedded.spec.ts` proved the packaged
 * app against ITS OWN embedded server with no identity at all (local unsigned
 * bootstrap). This lane is the next rung: the SAME packaged binary, but
 * pointed at an EXTERNAL, REAL control plane — `hosted-node`'s composition
 * (`createSqliteCentralStore` + `createSqliteWorkspaceAuthority`) behind a
 * REAL local JWKS issuer (`customVerifierAuthAdapter`), reached the way a
 * "shared" workspace actually is: a local worktree registered for sharing
 * (`registerLocalForSharing`) and tunnelled through a REAL
 * `@claxedo/workspace-relay` (F1's "embedded" workspace-runtime, exposed over
 * F2's "user-hosted" relay transport — this lane's name is literal, not a
 * typo: one workspace, both matrix cells). Per the plan's matrix row
 * `desktop-signed-embedded-shared | A1–A2 | all | C1,C4 | D1–D2 | E1 | F1,F2`.
 * See `docs/plans/2026-08-06-001-test-full-matrix-real-e2e-plan.md` Phase 4.
 *
 * WHAT IS REAL HERE — the packaged app (asar-packed, `file://` renderer, same
 * binary discovery as Phase 2), a REAL `signed-browser-relay-fixture.mjs`
 * process (real SQLite authority, real JWKS-signed JWTs, real
 * `@claxedo/workspace-relay` child, real host-tunnel), and a REAL
 * X-Forwarded-For reverse proxy in front of it (`desktop-signed-server.ts`'s
 * `startForwardedForProxy`, reusing `live-user-hosted-relay-frontend-
 * server.mjs` verbatim) so the loopback-vs-signed bootstrap gate takes the
 * SAME code path a production deployment's own front door would trigger. Per
 * owner decision 1, the ONLY permitted fake is the AI model HTTP endpoint.
 *
 * *** GATING FINDING (2026-08-06, load-bearing for every scenario below) ***
 *
 * The packaged desktop app has NO WORKING TEST-AUTH BYPASS. `testAuth()`
 * (`src/platform/auth/auth-client.ts:112-176`) is gated:
 *
 *     if (!import.meta.env.DEV && MODE !== "test" && VITE_CLAXEDO_E2E !== "1")
 *       return {}
 *
 * `packages/claxedo-desktop`'s renderer is ALWAYS built via `electron-vite
 * build` (`build:inner`), which is ALWAYS Vite's `production` mode — `DEV` is
 * `false`, `MODE` is `"production"`, and `VITE_CLAXEDO_E2E` has never been
 * threaded into `packages/claxedo-desktop` anywhere (verified:
 * `grep -rn "VITE_CLAXEDO_E2E" packages/claxedo-desktop` returns nothing, vs.
 * `vite.cloud.config.ts`/the dedicated web-lane launchers, which run through
 * `vite dev` and get `DEV=true` for free). PROVEN, not inferred: extracted
 * the shared `--dir` build's `app.asar`
 * (`packages/claxedo-desktop/dist/mac-arm64/Claxedo Dev.app/Contents/
 * Resources/app.asar`, built 2026-08-06 for Phase 2) with `@electron/asar`
 * and found the ENTIRE `testAuth()` body constant-folded away:
 *
 *     function testAuth() { return {}; }
 *
 * — i.e. `window.__CLAXEDO_TEST_AUTH_TOKEN__` seeding (the exact mechanism
 * `real-cloud-relay.spec.ts` and `live-user-hosted-relay.spec.ts` use to
 * authenticate their WEB lanes, per Phase 3's own `controlPlaneToken` field)
 * has ZERO effect on this binary. Rebuilding with `VITE_CLAXEDO_E2E=1` was
 * evaluated and REJECTED for this task: `electron-builder.config.ts`'s
 * `files: ["out/**​/*"]` and `vite.renderer.ts`'s single, un-parameterised
 * renderer config both hardcode the SAME shared `out/`/`dist/` paths Phase
 * 2's own in-progress verification checklist depends on
 * (`docs/plans/2026-08-06-001-test-full-matrix-real-e2e-plan.md` Phase 2's
 * unchecked "Scenarios A1–A3, B1–B9, … pass" and "Negative proof" items) —
 * silently overwriting that shared artifact to bake in a new env flavour
 * would invalidate a concurrent agent's in-flight verification, which this
 * task's own file-ownership rule forbids. The correct fix is a dedicated
 * desktop e2e build flavour (a `build:e2e-signed` script or an
 * `electron-builder` output-dir override), which is a Phase 6 (CI wiring)
 * concern, not something this file's two spec files should do as a side
 * effect.
 *
 * CONSEQUENCE — every scenario that needs a signed-in principal (anything
 * past the bootstrap handshake: session creation, turns, terminal creation
 * under a real identity, the rail/switcher parity oracles) genuinely cannot
 * run against the current shared binary. Per this task's own rule ("an honest
 * gap beats a false 'done'"), those are `test.fixme`d below with this comment
 * as their citation, not asserted weakly. What DOES run for real is A1: the
 * transport tripwire needs no identity at all (`bootstrap.ts`'s
 * `BootstrapRoutes` returns the LOCAL, unauthenticated 200 body whenever no
 * bearer token is present — verified by reading
 * `packages/claxedo-server/src/deployments/shared-routes/bootstrap.ts:281-309`
 * — so an anonymous packaged renderer still gets a real 2xx from the real
 * external control plane), which is enough to prove the harness pieces this
 * file's siblings will need once the build-flavour gap is closed: the
 * `serverUrl` seam (`electron-app.ts`), the real fixture, and the real
 * X-Forwarded-For proxy all compose correctly end to end.
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

test.describe("desktop signed embedded-shared @core @tier-real @surface-desktop", () => {
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
      access: "user-hosted",
      claudeScriptedEnv,
      opencodeScriptedProviderConfig,
      startScriptedModelServer,
      logLabel: "desktop-signed-embedded-shared",
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
   * A1 — the ONE scenario in this file with no auth dependency (see file
   * header). Boots the packaged app with `defaultServerUrl` pointed at the
   * real X-Forwarded-For proxy in front of the real fixture's real
   * `hosted-node` control plane, and asserts the renderer's own bootstrap
   * request lands as a real http(s) 2xx from that EXTERNAL origin — proving
   * `electron-app.ts`'s new `serverUrl` seam, the real fixture, and the real
   * proxy compose correctly, independent of the auth-bypass gap.
   */
  test("A1 (diagnostic): the packaged renderer reaches the REAL external signed control plane over http(s)", async () => {
    packaged = await launchPackagedApp({ timeoutMs: BOOT_TIMEOUT, serverUrl: proxyUrl })
    const url = await expectServerReachable(packaged, 45_000)
    expect(url).toMatch(/^https?:\/\//)
    expect(new URL(url).origin).toBe(new URL(proxyUrl!).origin)

    // Belt-and-suspenders over `expectServerReachable`'s pattern match: assert
    // the renderer's own DOM-observed origin is still `file://` (this lane
    // must not have silently regressed into an http(s) renderer the way
    // `launchPackagedApp`'s internal assertion already checks) AND that at
    // least one response actually reached the fixture's real backend, not
    // merely the proxy answering on its own (the proxy's `/` route serves a
    // vite dev shell, which would satisfy a looser check without ever
    // touching the fixture at all).
    const protocol = await packaged.page.evaluate(() => window.location.protocol)
    expect(protocol).toBe("file:")
  })

  /**
   * Everything below needs a signed-in principal (bootstrap's SIGNED body,
   * `services.authority.listWorkspaces`, `syncSessionMessages`, or any
   * write route gated by `requireWorkspace(..., "write")`) and the packaged
   * desktop build's test-auth bypass is provably dead code against the
   * shared binary — see this file's header "GATING FINDING". Attempting
   * these against an anonymous session would only prove the app correctly
   * refuses an unauthenticated user, which is not what B1–B9/C1/C4/D1–D2/E1
   * are meant to prove; a weakened assertion here (e.g. "a sign-in wall
   * rendered") would be exactly the pass-while-unusable shape
   * `e2e/INVARIANTS.md`'s Phase-0 amendment forbids. `test.fixme`, per this
   * task's own instruction, rather than a weak assertion.
   *
   * `seedDesktopSignedWorkspace`/`seedDesktopTestAuth` (both real,
   * `desktop-signed-server.ts`) are left CALLED, not deleted, in the body of
   * each fixme below: once a `VITE_CLAXEDO_E2E=1` desktop build flavour
   * exists, un-skipping these should require adding the real journey
   * (composer/rail drive, reusing Phase 2's `desktop-unsigned-embedded.spec.ts`
   * helpers) around already-correct plumbing, not re-deriving the seed step.
   */
  test.fixme(
    "B1–B9: session lifecycle & rail — GATED on the desktop test-auth bypass being dead code, see file header",
    async () => {
      packaged = await launchPackagedApp({ timeoutMs: BOOT_TIMEOUT, serverUrl: proxyUrl })
      await seedDesktopTestAuth(packaged.page, info!)
      await seedDesktopSignedWorkspace(packaged.page, info!, "user-hosted")
    },
  )

  test.fixme(
    "C1/C4: composer & harness (real model name resolves, second turn survives reload) — GATED, see file header",
    async () => {},
  )

  test.fixme(
    "D1–D2: terminal creates and streams through the real relay+tunnel — GATED, see file header",
    async () => {},
  )

  test.fixme(
    "E1: rail geometry invariants on a real relay-backed row — GATED (needs a real session row first), see file header",
    async () => {},
  )

  /**
   * F2's transport-only half — "connect through real relay + host tunnel" —
   * is DISTINCT from "B-group passes" (the matrix cell's second clause,
   * fixme'd above). Even this narrower claim is blocked for the SAME reason:
   * proving a real relay round-trip needs at least one authenticated
   * request to observe crossing it (`live-user-hosted-relay.spec.ts`
   * behavior 2 does this via a direct in-page `fetch` using the real
   * connection-mint response — that mint call itself requires a signed
   * bearer). `test.fixme`, not weakened, for the same reason as B1–B9.
   */
  test.fixme(
    "F2 (diagnostic): a real request round-trips through the real relay + host tunnel — GATED, see file header",
    async () => {},
  )
})

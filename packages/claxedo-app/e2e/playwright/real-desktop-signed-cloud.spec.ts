/**
 * SPEC: Packaged desktop signed account and remote access
 *
 * PURPOSE — Prove the file:// production bundle keeps hosted credentials in
 * Electron main, refreshes and restores them, and publishes a machine only
 * after an explicit zero-argument Remote Access action.
 *
 * STATE MODEL — The encrypted account record and encrypted machine identity
 * in the scratch Electron profile are authoritative. The real hosted server
 * owns OAuth refresh tokens and enrollment rows. Main owns the only bearer and
 * private key; the renderer receives decoded state and named operations only.
 *
 * ANATOMY — A packaged asar build talks through a real X-Forwarded-For proxy
 * to the real hosted-node app, SQLite authority, local JWKS issuer, OAuth
 * refresh endpoint, and host-enrollment routes. Playwright drives production
 * preload IPC and the real Settings > Devices surface.
 *
 * BEHAVIORS — 1. An expired encrypted credential refreshes on its first named
 * operation and the rotated record restores after restart. 2. Signed launch
 * alone writes no machine identity and enrolls nothing. 3. Two simultaneous
 * Enables share one enrollment. 4. Pause stops publication without deleting
 * identity. 5. Revoke during a delayed heartbeat deletes identity and the late
 * response cannot resurrect it. 6. Re-enable mints a different host id.
 *
 * INVARIANTS — No bearer or refresh token crosses IPC; renderer-triggered
 * host enrollment operations are withheld; Host Connector IPC takes no input;
 * one start owns one enrollment/timer; revocation wins every in-flight race.
 *
 * HARNESS NOTES — The only fake is the scripted model required by the shared
 * real hosted fixture. `VITE_CLAXEDO_E2E=1` must be baked into the packaged
 * renderer so its supported test-auth bootstrap can identify the UI caller.
 *
 * OUT OF SCOPE — Third-party OAuth browser UI, Clerk-specific token shape, and
 * a physical second device. Those require credentialed live lanes.
 */
import { expect, test, type BrowserContext } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { expectServerReachable, launchPackagedApp, type PackagedApp } from "../helpers/electron-app"
import {
  claudeScriptedEnv,
  opencodeScriptedProviderConfig,
  startScriptedModelServer,
} from "../helpers/scripted-model-server"
import {
  startForwardedForProxy,
  startSignedFixture,
  type SignedFixtureInfo,
} from "../helpers/desktop-signed-server"

const BOOT_TIMEOUT = 90_000
const TIER_REAL = process.env.CLAXEDO_TIER_REAL_E2E === "1"

type DesktopStats = {
  refreshes: number
  hostRequests: Array<{
    method: string
    path: string
    phase: "started" | "completed"
    status?: number
    body?: Record<string, unknown>
  }>
}

test.describe.configure({ mode: "serial" })
test.describe("real desktop signed cloud @core @tier-real @surface-desktop", () => {
  let fixtureClose: (() => Promise<void>) | undefined
  let proxyClose: (() => Promise<void>) | undefined
  let packaged: PackagedApp | undefined
  let proxyUrl = ""
  let info: SignedFixtureInfo

  const accountEnv = () => ({
    CLAXEDO_ACCOUNT_AUTHORIZE_URL: `${info.backendUrl}/__fixture/authorize`,
    CLAXEDO_ACCOUNT_TOKEN_URL: `${info.backendUrl}/__fixture/oauth/token`,
    CLAXEDO_ACCOUNT_CLIENT_ID: "desktop-tier-real",
    CLAXEDO_ACCOUNT_SCOPE: "openid offline_access",
    CLAXEDO_SERVER_ORIGIN: info.backendUrl,
    CLAXEDO_HOST_CONNECTOR_HEARTBEAT_INTERVAL_MS: "150",
  })

  const installRendererIdentity = async (context: BrowserContext) => {
    await context.addInitScript((token: string) => {
      const scope = window as typeof window & {
        __CLAXEDO_TEST_AUTH_TOKEN__?: string
        __CLAXEDO_TEST_AUTH_USER__?: { id: string }
      }
      scope.__CLAXEDO_TEST_AUTH_TOKEN__ = token
      scope.__CLAXEDO_TEST_AUTH_USER__ = { id: "user_browser" }
    }, info.controlPlaneToken)
  }

  const stats = async () => {
    const response = await fetch(`${info.backendUrl}/__fixture/desktop-stats`)
    expect(response.status, await response.clone().text()).toBe(200)
    return await response.json() as DesktopStats
  }

  const seedCredential = async (expiresInSeconds: number) => {
    packaged = await launchPackagedApp({
      timeoutMs: BOOT_TIMEOUT,
      serverUrl: proxyUrl,
      env: accountEnv(),
      beforeShellWindow: installRendererIdentity,
      preserveUserDataDir: true,
    })
    const userDataDir = packaged.userDataDir
    const record = await packaged.app.evaluate(({ safeStorage }, tokens: {
      accessToken: string
      refreshToken: string
      expiresAt: number
    }) => ({
      ciphertext: safeStorage.encryptString(JSON.stringify(tokens)).toString("base64"),
      backend: safeStorage.getSelectedStorageBackend?.() ?? "unknown",
      expiresAt: tokens.expiresAt,
    }), {
      accessToken: info.controlPlaneToken,
      refreshToken: info.desktopRefreshToken,
      expiresAt: Math.floor(Date.now() / 1000) + expiresInSeconds,
    })
    const credential = JSON.stringify(record)
    await fs.writeFile(path.join(userDataDir, "account-credential.json"), credential, { mode: 0o600 })
    expect(credential).not.toContain(info.controlPlaneToken)
    expect(credential).not.toContain(info.desktopRefreshToken)
    await packaged.close()
    packaged = undefined
    expect(await fs.stat(path.join(userDataDir, "account-credential.json")).then(() => true).catch(() => false)).toBe(true)
    return userDataDir
  }

  const relaunch = async (userDataDir: string, preserveUserDataDir = false) => {
    packaged = await launchPackagedApp({
      timeoutMs: BOOT_TIMEOUT,
      serverUrl: proxyUrl,
      env: accountEnv(),
      beforeShellWindow: installRendererIdentity,
      userDataDir,
      preserveUserDataDir,
    })
    return packaged
  }

  test.beforeEach(async () => {
    test.skip(!TIER_REAL, "requires CLAXEDO_TIER_REAL_E2E=1")
    const fixture = await startSignedFixture({
      access: "cloud",
      claudeScriptedEnv,
      opencodeScriptedProviderConfig,
      startScriptedModelServer,
      logLabel: "desktop-signed-cloud",
      hostHeartbeatDelayMs: 2_000,
    })
    info = fixture.info
    fixtureClose = fixture.close
    const proxy = await startForwardedForProxy(info.backendUrl)
    proxyUrl = proxy.url
    proxyClose = proxy.close
  })

  test.afterEach(async () => {
    await packaged?.close()
    packaged = undefined
    await proxyClose?.()
    proxyClose = undefined
    await fixtureClose?.()
    fixtureClose = undefined
  })

  // Three packaged boots plus a boundary wait that can approach the refresh
  // test's full boot budget — 180s left no room once the budget became honest.
  test.setTimeout(300_000)

  test("main-process credential refreshes mid-session and its rotation restores after restart", async () => {
    // The refresh skew is 60s. Start outside it so the first operation uses
    // the held access token, then let this already-open session cross the
    // boundary and prove the next operation renews in place. The margin above
    // the skew is the whole budget for closing the seed app and cold-booting
    // the packaged relaunch below — expiry is stamped inside the SEED app, so
    // every second of relaunch spends it. 65s (a 5s budget) failed on every
    // CI runner and on a local Linux box alike: a packaged boot takes ~30s,
    // the first operation then sat inside the skew, and the refresh it
    // triggered failed the no-refresh assertion. The price of the honest
    // budget is paid in the boundary poll, which must be prepared to wait
    // out whatever the relaunch did not consume.
    const bootBudgetSeconds = 90
    const userDataDir = await seedCredential(60 + bootBudgetSeconds)
    const before = await stats()
    const first = await relaunch(userDataDir, true)
    expect(await first.page.evaluate(() => window.location.protocol)).toBe("file:")
    expect(new URL(await expectServerReachable(first, 45_000)).origin).toBe(new URL(proxyUrl).origin)
    expect(await first.page.evaluate(async () => {
      const api = (window as unknown as { api: { account: { state(): Promise<unknown> } } }).api
      return api.account.state()
    }), first.appLog.join("\n")).toMatchObject({ status: "signed" })

    const listCloudWorkspaces = () => first.page.evaluate(async () => {
      const api = (window as unknown as {
        api: { account: { run(name: string, input?: Record<string, unknown>): Promise<unknown> } }
      }).api
      return api.account.run("workspace.list.cloud")
    })
    const workspaces = await listCloudWorkspaces()
    expect(workspaces).toMatchObject({ workspaces: expect.any(Array) })
    expect((await stats()).refreshes, first.appLog.join("\n")).toBe(before.refreshes)
    // Worst case the relaunch was instant and the skew boundary is still a
    // full bootBudgetSeconds away; the poll has to be allowed to outlive it.
    // A transiently failed operation must not abort the wait: macOS runners
    // occasionally drop the main-process connection to the fixture for one
    // call ("TypeError: fetch failed"), and the account service itself treats
    // a failed refresh as transient — the credential stays put and the next
    // call renews normally. The poll's subject is the refresh counter, so a
    // dropped iteration just polls again.
    await expect.poll(async () => {
      await listCloudWorkspaces().catch(() => undefined)
      return (await stats()).refreshes
    }, { timeout: (bootBudgetSeconds + 20) * 1000 }).toBe(before.refreshes + 1)

    const persisted = await fs.readFile(path.join(userDataDir, "account-credential.json"), "utf8")
    expect(persisted).not.toContain(info.controlPlaneToken)
    expect(persisted).not.toContain(info.desktopRefreshToken)

    await first.close()
    packaged = undefined
    const restarted = await relaunch(userDataDir)
    expect(await restarted.page.evaluate(async () => {
      const api = (window as unknown as { api: { account: { state(): Promise<unknown> } } }).api
      return api.account.state()
    })).toMatchObject({ status: "signed" })
    expect(await restarted.page.evaluate(async () => {
      const api = (window as unknown as {
        api: { account: { run(name: string, input?: Record<string, unknown>): Promise<unknown> } }
      }).api
      return api.account.run("workspace.list.cloud")
    })).toMatchObject({ workspaces: expect.any(Array) })
  })

  test("explicit Remote Access is single-flight and revocation wins a delayed heartbeat", async ({}, testInfo) => {
    const before = await stats()
    const userDataDir = await seedCredential(-1)
    const app = await relaunch(userDataDir)
    const identityFile = path.join(userDataDir, "host-machine-identity.json")

    expect(await fs.stat(identityFile).then(() => true).catch(() => false)).toBe(false)
    expect((await stats()).hostRequests).toHaveLength(before.hostRequests.length)
    expect(await app.page.evaluate(async () => {
      const api = (window as unknown as {
        api: { account: { run(name: string, input?: Record<string, unknown>): Promise<unknown> } }
      }).api
      return api.account.run("host.enrollCurrentMachine", {
        hostId: "host_attacker",
        publicKey: "attacker",
        signature: "attacker",
      }).then(() => "allowed", (error) => String(error))
    })).toContain("not available to the renderer")
    expect(await app.page.evaluate(() => {
      const bridge = (window as unknown as { api: { hostConnector: Record<string, Function> } }).api.hostConnector
      return [bridge.start.length, bridge.pause.length, bridge.revoke.length]
    })).toEqual([0, 0, 0])

    await app.page.getByTestId("rail-account-trigger").click()
    await app.page.getByRole("menuitem", { name: /settings/i }).click()
    await app.page.getByRole("tab", { name: "Devices" }).click()
    const enable = app.page.getByRole("button", { name: "Enable remote access" })
    await expect(enable).toBeVisible()
    const startResults = await app.page.evaluate(async () => {
      const bridge = (window as unknown as {
        api: { hostConnector: { start(): Promise<unknown> } }
      }).api.hostConnector
      return Promise.all([bridge.start(), bridge.start()])
    })
    expect(startResults, JSON.stringify({ stats: await stats(), appLog: app.appLog }, null, 2))
      .toEqual([expect.objectContaining({ status: "enrolled" }), expect.objectContaining({ status: "enrolled" })])
    await expect(app.page.getByRole("heading", { name: "Open this workspace on your phone" })).toBeVisible({ timeout: 30_000 })

    const enrollmentPaths = ["/api/claxedo/host/enrollments/requests", "/api/claxedo/host/enrollments"]
    await expect.poll(async () => {
      const current = await stats()
      return enrollmentPaths.map((target) => current.hostRequests.filter((request) =>
        request.phase === "started" && request.path === target).length)
    }).toEqual(enrollmentPaths.map((target) =>
      before.hostRequests.filter((request) => request.phase === "started" && request.path === target).length + 1))

    const firstHostId = (await stats()).hostRequests.find((request) =>
      request.phase === "started" && request.path.endsWith("/requests") &&
      !before.hostRequests.includes(request))?.body?.hostId
    expect(firstHostId).toMatch(/^host_/)
    expect(await fs.stat(identityFile).then(() => true).catch(() => false)).toBe(true)

    await app.page.evaluate(async () => {
      const api = (window as unknown as { api: { hostConnector: { pause(): Promise<unknown> } } }).api
      await api.hostConnector.pause()
    })
    await expect(app.page.getByRole("button", { name: "Enable remote access" })).toBeVisible()
    const heartbeatBeforeRestart = (await stats()).hostRequests.filter((request) =>
      request.phase === "started" && request.path.endsWith("/heartbeat")).length
    await app.page.getByRole("button", { name: "Enable remote access" }).click()

    let heartbeatStarted = heartbeatBeforeRestart
    await expect.poll(async () => {
      heartbeatStarted = (await stats()).hostRequests.filter((request) =>
        request.phase === "started" && request.path.endsWith("/heartbeat")).length
      return heartbeatStarted
    }).toBeGreaterThan(heartbeatBeforeRestart)

    await app.page.evaluate(async () => {
      const api = (window as unknown as { api: { hostConnector: { revoke(): Promise<unknown> } } }).api
      await api.hostConnector.revoke()
    })
    expect(await fs.stat(identityFile).then(() => true).catch(() => false)).toBe(false)
    await expect.poll(async () => (await stats()).hostRequests.filter((request) =>
      request.phase === "completed" && request.path.endsWith("/heartbeat")).length,
    { timeout: 10_000 }).toBeGreaterThanOrEqual(heartbeatStarted)
    await expect.poll(async () => {
      return app.page.evaluate(async () => {
        const api = (window as unknown as { api: { hostConnector: { status(): Promise<{ status: string }> } } }).api
        return (await api.hostConnector.status()).status
      })
    }, { timeout: 10_000 }).toBe("stopped")
    await expect(app.page.getByRole("button", { name: "Enable remote access" })).toBeVisible()

    await app.page.getByRole("button", { name: "Enable remote access" }).click()
    await expect.poll(async () => {
      const requests = (await stats()).hostRequests.filter((request) =>
        request.phase === "started" && request.path.endsWith("/requests"))
      return requests.at(-1)?.body?.hostId
    }).not.toBe(firstHostId)
    await expect(app.page.getByRole("heading", { name: "Open this workspace on your phone" })).toBeVisible()
    await app.page.screenshot({ path: testInfo.outputPath("remote-access-enabled.png"), fullPage: true })
  })
})

import { expect, test } from "@playwright/test"
import { expectServerReachable, launchPackagedApp, type PackagedApp } from "../helpers/electron-app"
import {
  claudeScriptedEnv,
  opencodeScriptedProviderConfig,
  startScriptedModelServer,
} from "../helpers/scripted-model-server"
import { startForwardedForProxy, startSignedFixture } from "../helpers/desktop-signed-server"

const BOOT_TIMEOUT = 90_000

// This production-binary lane owns the cloud fixture transport boundary.
// Authenticated cloud journeys belong in an executable signed-E2E lane once
// that renderer build exists; placeholder scenarios are not tests.
test.describe("desktop signed cloud @core @tier-real @surface-desktop", () => {
  let fixtureClose: (() => Promise<void>) | undefined
  let proxyClose: (() => Promise<void>) | undefined
  let packaged: PackagedApp | undefined
  let proxyUrl: string | undefined

  test.beforeAll(async () => {
    const fixture = await startSignedFixture({
      access: "cloud",
      claudeScriptedEnv,
      opencodeScriptedProviderConfig,
      startScriptedModelServer,
      logLabel: "desktop-signed-cloud",
    })
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

  test("A1 (diagnostic): the packaged renderer reaches the real external cloud control plane over http(s)", async () => {
    packaged = await launchPackagedApp({ timeoutMs: BOOT_TIMEOUT, serverUrl: proxyUrl })
    const url = await expectServerReachable(packaged, 45_000)
    expect(url).toMatch(/^https?:\/\//)
    expect(new URL(url).origin).toBe(new URL(proxyUrl!).origin)
    expect(await packaged.page.evaluate(() => window.location.protocol)).toBe("file:")
  })
})

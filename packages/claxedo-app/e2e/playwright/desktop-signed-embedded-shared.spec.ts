import { expect, test } from "@playwright/test"
import { expectServerReachable, launchPackagedApp, type PackagedApp } from "../helpers/electron-app"
import {
  claudeScriptedEnv,
  opencodeScriptedProviderConfig,
  startScriptedModelServer,
} from "../helpers/scripted-model-server"
import { startForwardedForProxy, startSignedFixture } from "../helpers/desktop-signed-server"

const BOOT_TIMEOUT = 90_000

// This production-binary lane owns the external signed control-plane transport
// boundary. Authenticated journeys require an independently built signed-E2E
// renderer; they enter this suite only when that build and its assertions exist.
test.describe("desktop signed embedded-shared @core @tier-real @surface-desktop", () => {
  let fixtureClose: (() => Promise<void>) | undefined
  let proxyClose: (() => Promise<void>) | undefined
  let packaged: PackagedApp | undefined
  let proxyUrl: string | undefined

  test.beforeAll(async () => {
    const fixture = await startSignedFixture({
      access: "user-hosted",
      claudeScriptedEnv,
      opencodeScriptedProviderConfig,
      startScriptedModelServer,
      logLabel: "desktop-signed-embedded-shared",
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

  test("A1 (diagnostic): the packaged renderer reaches the real external signed control plane over http(s)", async () => {
    packaged = await launchPackagedApp({ timeoutMs: BOOT_TIMEOUT, serverUrl: proxyUrl })
    const url = await expectServerReachable(packaged, 45_000)
    expect(url).toMatch(/^https?:\/\//)
    expect(new URL(url).origin).toBe(new URL(proxyUrl!).origin)
    expect(await packaged.page.evaluate(() => window.location.protocol)).toBe("file:")
  })
})

import { expect, test } from "@playwright/test"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { expectServerReachable, launchPackagedApp, type PackagedApp } from "../helpers/electron-app"
import {
  claudeScriptedEnv,
  opencodeScriptedProviderConfig,
  startScriptedModelServer,
} from "../helpers/scripted-model-server"
import { startForwardedForProxy, startSignedFixture } from "../helpers/desktop-signed-server"
import { descendantCommands } from "../helpers/process-inventory"
import { startDesktopNativeAuthFixture, type DesktopNativeAuthFixture } from "../helpers/desktop-native-auth-fixture"

const BOOT_TIMEOUT = 90_000
const HOSTED_CHUNK = "desktop-hosted-contributions-"

async function openScratchWorkspace(app: PackagedApp) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-u8-signed-")))
  execFileSync("git", ["init", "-b", "main"], { cwd: directory })
  await fs.writeFile(path.join(directory, "README.md"), "U8 signed activation fixture\n")
  execFileSync("git", ["-c", "user.email=e2e@test.com", "-c", "user.name=e2e", "add", "-A"], { cwd: directory })
  execFileSync("git", ["-c", "user.email=e2e@test.com", "-c", "user.name=e2e", "commit", "-m", "init"], {
    cwd: directory,
  })

  const serverBase = new URL(await expectServerReachable(app, 45_000)).origin
  const resolveUrl = new URL("/api/claxedo/workspace/resolve", serverBase)
  resolveUrl.searchParams.set("directory", directory)
  resolveUrl.searchParams.set("create", "true")
  const resolved = await fetch(resolveUrl)
  if (!resolved.ok) {
    throw new Error(
      `GATING: failed to register signed-activation workspace (${resolved.status}): ${await resolved.text()}`,
    )
  }
  const { workspaceId } = (await resolved.json()) as { workspaceId: string }
  await app.page.evaluate(
    async ({ worktree }) => {
      await (
        window as unknown as { api: { storeSet(name: string, key: string, value: string): Promise<void> } }
      ).api.storeSet(
        "opencode.global.dat",
        "server",
        JSON.stringify({
          list: [],
          projects: { local: [{ worktree, expanded: true }] },
          lastProject: {},
          workspaceServer: {},
          closedProjects: {},
        }),
      )
    },
    { worktree: directory },
  )
  await app.page.reload()
  await expect(app.page.locator(`[data-testid="project-group"][data-project-id="${workspaceId}"]`)).toBeVisible({
    timeout: 30_000,
  })
  return directory
}

/**
 * This fixture proves packaged composition and activation order. Native OS
 * credential persistence is qualified by the separately owner-gated release
 * lanes, so this test supplies deterministic safeStorage semantics only.
 */
async function installFixtureOAuthEnvironment(app: PackagedApp) {
  await app.app.evaluate(({ safeStorage, shell }) => {
    ;(globalThis as typeof globalThis & { __claxedoU8OAuthUrls?: string[] }).__claxedoU8OAuthUrls = []
    Object.defineProperties(safeStorage, {
      isEncryptionAvailable: { configurable: true, value: () => true },
      // Linux validates the reported backend against an encrypting-keyring
      // allowlist. `keychain` is the macOS name and correctly fails closed on
      // Linux, so the cross-platform fixture must report the native secure
      // backend shape for the process it is exercising.
      getSelectedStorageBackend: {
        configurable: true,
        value: () => (process.platform === "linux" ? "gnome_libsecret" : "unknown"),
      },
      encryptString: {
        configurable: true,
        value: (plaintext: string) => Buffer.from(`claxedo-u8:${plaintext}`, "utf8"),
      },
      decryptString: {
        configurable: true,
        value: (ciphertext: Buffer) => ciphertext.toString("utf8").replace(/^claxedo-u8:/, ""),
      },
    })
    const openExternal = async (url: string) => {
      ;(globalThis as typeof globalThis & { __claxedoU8OAuthUrls: string[] }).__claxedoU8OAuthUrls.push(url)
      const response = await fetch(url, { redirect: "follow" })
      if (!response.ok) throw new Error(`fixture OAuth browser failed: ${response.status}`)
      await response.text()
    }
    Object.defineProperty(shell, "openExternal", { configurable: true, value: openExternal })
  })
}

test.describe("U8 packaged product boundary @core @tier-real @surface-desktop", () => {
  let fixtureClose: (() => Promise<void>) | undefined
  let proxyClose: (() => Promise<void>) | undefined
  let oauth: DesktopNativeAuthFixture | undefined
  let proxyUrl: string | undefined
  let packaged: PackagedApp | undefined
  let scratchWorkspace: string | undefined

  test.afterEach(async () => {
    await packaged?.close()
    packaged = undefined
    if (scratchWorkspace) await fs.rm(scratchWorkspace, { recursive: true, force: true })
    scratchWorkspace = undefined
    await oauth?.close()
    oauth = undefined
    await proxyClose?.()
    proxyClose = undefined
    await fixtureClose?.()
    fixtureClose = undefined
  })

  test.setTimeout(180_000)

  test("unsigned startup excludes every optional activation from the module and process trace", async () => {
    const hostedRequests: string[] = []
    packaged = await launchPackagedApp({
      timeoutMs: BOOT_TIMEOUT,
      beforeShellWindow: async (context) => {
        context.on("request", (request) => {
          if (request.url().includes(HOSTED_CHUNK)) hostedRequests.push(request.url())
        })
      },
    })

    expect(hostedRequests).toEqual([])
    expect(
      await packaged.page.evaluate(
        async () =>
          await (
            window as unknown as {
              api: { account: { state(): Promise<unknown> } }
            }
          ).api.account.state(),
      ),
    ).toEqual({ status: "unsigned" })
    expect(
      await packaged.page.evaluate(
        async () =>
          await (
            window as unknown as {
              api: { hostConnector: { status(): Promise<unknown> } }
            }
          ).api.hostConnector.status(),
      ),
    ).toMatchObject({
      status: "not-started",
      signedIn: false,
    })
    expect(
      descendantCommands(packaged.app.process().pid!).filter((command) => command.includes("host-connector/index.js")),
    ).toEqual([])
  })

  test("fixture OAuth activates the fingerprinted hosted renderer once without starting Host Connector", async () => {
    const fixture = await startSignedFixture({
      access: "user-hosted",
      claudeScriptedEnv,
      opencodeScriptedProviderConfig,
      startScriptedModelServer,
      logLabel: "desktop-u8-package-boundary",
    })
    fixtureClose = fixture.close
    const proxy = await startForwardedForProxy(fixture.info.backendUrl)
    proxyUrl = proxy.url
    proxyClose = proxy.close
    oauth = await startDesktopNativeAuthFixture({
      upstreamOrigin: proxyUrl,
      accessToken: fixture.info.controlPlaneToken,
      refreshToken: fixture.info.desktopRefreshToken,
    })
    const hostedRequests: string[] = []
    packaged = await launchPackagedApp({
      timeoutMs: BOOT_TIMEOUT,
      env: {
        CLAXEDO_CORE_ORIGIN: oauth.origin,
      },
      testOnlyHttpsTrust: { caPath: oauth.caPath, certificateSpki: oauth.certificateSpki },
      beforeShellWindow: async (context) => {
        context.on("request", (request) => {
          if (request.url().includes(HOSTED_CHUNK)) hostedRequests.push(request.url())
        })
      },
    })
    await installFixtureOAuthEnvironment(packaged)

    expect(hostedRequests).toEqual([])
    scratchWorkspace = await openScratchWorkspace(packaged)
    await packaged.page.getByTestId("rail-account-trigger").click()
    const signIn = packaged.page.getByRole("menuitem", { name: "Sign in" })
    await expect(signIn).toBeVisible()
    await signIn.evaluate((element) => {
      setTimeout(
        () =>
          element.dispatchEvent(
            new PointerEvent("pointerup", {
              bubbles: true,
              button: 0,
              pointerType: "mouse",
            }),
          ),
        0,
      )
    })
    await expect
      .poll(() => oauth!.authorizeRequests.length, { timeout: 15_000 })
      .toBe(1)
      .catch(async () => {
        const account = await packaged!.page.evaluate(
          async () =>
            await (
              window as unknown as {
                api: { account: { state(): Promise<unknown> } }
              }
            ).api.account.state(),
        )
        const openedUrls = await packaged!.app.evaluate(
          () => (globalThis as typeof globalThis & { __claxedoU8OAuthUrls?: string[] }).__claxedoU8OAuthUrls ?? [],
        )
        throw new Error(
          `GATING: fixture authorization did not reach the OAuth server: ${JSON.stringify({
            account,
            openedUrls,
            appLogTail: packaged!.appLog.join("").split("\n").slice(-8),
          })}`,
        )
      })
    await expect.poll(() => oauth!.tokenRequests.length, { timeout: 15_000 }).toBe(1)
    await expect
      .poll(
        async () =>
          await packaged!.page.evaluate(
            async () =>
              await (
                window as unknown as {
                  api: { account: { state(): Promise<unknown> } }
                }
              ).api.account.state(),
          ),
        {
          timeout: 45_000,
        },
      )
      .toMatchObject({ status: "signed" })
    await expect.poll(() => hostedRequests, { timeout: 30_000 }).toHaveLength(1)

    expect(oauth!.authorizeRequests).toHaveLength(1)
    expect(oauth!.authorizeRequests[0]!.searchParams.get("code_challenge_method")).toBe("S256")
    expect(oauth!.tokenRequests).toHaveLength(1)
    expect(oauth!.tokenRequests[0]!.get("client_id")).toBe("claxedo-desktop-e2e")
    expect(oauth!.tokenRequests[0]!.get("resource")).toBe(`${oauth!.origin}/control-plane`)
    expect(
      await packaged.page.evaluate(
        async () =>
          await (
            window as unknown as {
              api: { hostConnector: { status(): Promise<unknown> } }
            }
          ).api.hostConnector.status(),
      ),
    ).toMatchObject({
      status: "not-started",
      signedIn: true,
    })
    expect(
      descendantCommands(packaged.app.process().pid!).filter((command) => command.includes("host-connector/index.js")),
    ).toEqual([])

    const logout = await packaged.page.evaluate(
      async () =>
        await (
          window as unknown as {
            api: { account: { signOut(): Promise<unknown> } }
          }
        ).api.account.signOut(),
    )
    expect(logout).toEqual({ status: "unsigned", remoteRevocation: "confirmed" })
    expect(oauth.revokeRequests).toHaveLength(1)
    expect(
      await fs
        .stat(path.join(packaged.userDataDir, "account-credential.json"))
        .then(() => true)
        .catch(() => false),
    ).toBe(false)
  })
})

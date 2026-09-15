import {
  _electron as electron,
  expect,
  type BrowserContext,
  type ElectronApplication,
  type Page,
} from "@playwright/test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { shutdownPackagedTestDaemon } from "./desktop-daemon"

// `import.meta.url`, not `__dirname`: this suite is ESM and `__dirname` is not
// defined there — it fails at module load, before any test is collected, with
// "No tests found" as the only visible symptom.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, "../../../..")
const DESKTOP = path.join(REPO_ROOT, "packages/claxedo-desktop")

/**
 * Finds the app `electron-builder --dir` left under `dist/`. `--dir` skips DMG and
 * notarisation but still asar-packs, so the renderer loads over `file://`. The bundle name
 * depends on the release channel (`Claxedo Dev.app` vs `Claxedo.app`), so it is discovered
 * rather than pinned.
 */
async function discoverPackagedBinary(): Promise<string[]> {
  const dist = path.join(DESKTOP, "dist")
  const archDirs = await fs.readdir(dist).catch(() => [] as string[])
  const found: string[] = []

  for (const archDir of archDirs) {
    const abs = path.join(dist, archDir)
    if (process.platform === "darwin") {
      if (!archDir.startsWith("mac")) continue
      for (const entry of await fs.readdir(abs).catch(() => [] as string[])) {
        if (!entry.endsWith(".app")) continue
        found.push(path.join(abs, entry, "Contents/MacOS", entry.replace(/\.app$/, "")))
      }
      continue
    }
    if (!archDir.endsWith("-unpacked")) continue
    for (const entry of await fs.readdir(abs).catch(() => [] as string[])) {
      const candidate = path.join(abs, entry)
      const isFile = await fs
        .stat(candidate)
        .then((stat) => stat.isFile())
        .catch(() => false)
      if (isPackagedApplicationEntry(process.platform, entry, isFile)) {
        found.push(candidate)
      }
    }
  }
  return found
}

const ELECTRON_LINUX_HELPERS = new Set(["chrome-sandbox", "chrome_crashpad_handler"])

export function isPackagedApplicationEntry(platform: NodeJS.Platform, entry: string, isFile: boolean) {
  if (!isFile) return false
  if (platform === "win32") return entry.endsWith(".exe")
  if (platform !== "linux") return false
  return !entry.includes(".") && !ELECTRON_LINUX_HELPERS.has(entry)
}

async function resolvePackagedBinary(): Promise<string> {
  const candidates = process.env.CLAXEDO_E2E_DESKTOP_BIN
    ? [process.env.CLAXEDO_E2E_DESKTOP_BIN]
    : await discoverPackagedBinary()
  for (const candidate of candidates) {
    if (
      await fs
        .stat(candidate)
        .then(() => true)
        .catch(() => false)
    )
      return candidate
  }
  throw new Error(
    "GATING: no packaged desktop binary found. Build one first:\n" +
      "  cd packages/claxedo-desktop && bun run build && npx electron-builder --dir --config electron-builder.config.ts\n" +
      `Discovered candidates:\n  ${candidates.join("\n  ") || "(none)"}\n` +
      "Or set CLAXEDO_E2E_DESKTOP_BIN to the executable.",
  )
}

/**
 * Resolve the main local shell window (`index.local.html`), ignoring the boot splash.
 *
 * Polls rather than relying on a single `window` event: the shell may already
 * exist by the time we look, and it may also replace the splash after several
 * seconds of embedded-server startup, so neither "take the first" nor "take the
 * next" is correct on its own.
 */
async function waitForShellWindow(app: ElectronApplication, timeoutMs: number, appLog: string[]): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
      if (candidate.isClosed()) continue
      if (candidate.url().includes("index.local.html")) return candidate
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(
    "GATING: the packaged app never opened its local shell window (index.local.html). Windows seen: " +
      (app
        .windows()
        .map((w) => w.url())
        .join(", ") || "(none)") +
      "\nMain-process output:\n" +
      (appLog.join("").trim() || "(none)"),
  )
}

export type PackagedApp = {
  app: ElectronApplication
  page: Page
  /** Scratch `userData` root for this run (also parents CLAXEDO_DATA_DIR); removed by close(). */
  userDataDir: string
  /** Successful http(s) responses observed since launch. See {@link expectServerReachable}. */
  serverResponses: string[]
  /** Main-process stdout+stderr, so a mid-test quit reports its cause. */
  appLog: string[]
  close: () => Promise<void>
}

/**
 * Boots the packaged app against a scratch profile. `userData` is a fresh `mkdtemp` per
 * run: the real settings store is shared across release and Dev channels, so a setting
 * persisted by one run (or by the developer's own app) would leak into the next.
 *
 * The app boots its own embedded claxedo-server. Only the scripted model endpoint (`env`)
 * is fake.
 */
export async function launchPackagedApp(
  input: {
    /** Extra env for the app — the scripted model endpoint goes here. */
    env?: Record<string, string>
    /** Overrides the default 60s first-window wait; the embedded server boots first. */
    timeoutMs?: number
    /**
     * Points the packaged app at an external server instead of its embedded one (the signed
     * lanes' `signed-browser-relay-fixture.mjs`).
     *
     * `CLAXEDO_SERVER_URL` is read only when `!IS_PACKAGED`, so a `--dir` build ignores it.
     * The one seam a packaged build honours is `getSavedServerUrl()` (`main/server.ts`), which
     * reads `defaultServerUrl` from an `electron-store` file the main process opens during
     * `initialize()`, before any renderer or IPC exists — so it is written to
     * `<userDataDir>/claxedo.settings.json` before `electron.launch()`.
     *
     * If the server is not reachable yet, `checkHealthOrAskRetry` opens a native dialog
     * Playwright cannot click and the launch hangs until `timeoutMs`; await the external
     * server's readiness first.
     */
    serverUrl?: string
    /**
     * Runs with the app's `BrowserContext` right after `electron.launch()`, before either
     * window is queried. This is the only point where `context().addInitScript(...)` still
     * precedes the shell's first navigation: `waitForShellWindow()` returns only after
     * `index.local.html` has loaded, so a page-level init script misses boot-time fetches
     * and toasts. `boot-observer.ts`'s `installBootObserver` is the intended caller.
     */
    beforeShellWindow?: (context: BrowserContext) => Promise<void>
    /** Reuse a scratch profile across a restart. The caller remains its owner. */
    userDataDir?: string
    /** Keep the profile after close so a later launch can prove restoration. */
    preserveUserDataDir?: boolean
    /**
     * Test-only trust for the local HTTPS auth/core fixture. The production app
     * has no certificate bypass: Node trusts this one CA file and Chromium pins
     * this one SPKI only in the spawned e2e process.
     */
    testOnlyHttpsTrust?: { caPath: string; certificateSpki: string }
  } = {},
): Promise<PackagedApp> {
  const executablePath = await resolvePackagedBinary()
  const userDataDir = input.userDataDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-e2e-desktop-")))
  await fs.mkdir(userDataDir, { recursive: true })
  if (input.serverUrl) {
    // electron-store with no schema/migrations persists plain `JSON.stringify(store)`, so
    // this is exactly what `store.get("defaultServerUrl")` reads.
    await fs.writeFile(
      path.join(userDataDir, "claxedo.settings.json"),
      JSON.stringify({ defaultServerUrl: input.serverUrl }, null, 2),
    )
  }
  // Three roots are isolated per run, and each one matters:
  // - `CLAXEDO_DATA_DIR`: the embedded claxedo-server's own store. It takes an exclusive
  //   lock (`data_dir_already_owned`, 409), so sharing it with a running dev server or
  //   installed app fails the launch.
  // - `CLAXEDO_DESKTOP_USER_DATA_DIR`: `main/index.ts` passes it to
  //   `app.setPath("userData", …)`, overriding Chromium's `--user-data-dir`. Without it the
  //   app reads the real channel store, finds the developer's own projects, and asks the
  //   scratch server for directories it never registered (404/503 toasts at boot). The
  //   `--user-data-dir` arg is kept only for Chromium's own cache paths.
  // - `ZDOTDIR`: the shell a terminal spawns runs the operator's rc files against the same
  //   PTY a spec types into (oh-my-zsh's update prompt once swallowed the first keystroke
  //   of an `echo`), so zsh reads its startup files from an empty directory instead.
  //   `HOME` is left alone: the real git identity, `claude` credential and PATH are what
  //   make the lane's harnesses real.
  const dataDir = path.join(userDataDir, "server-data")
  await fs.mkdir(dataDir, { recursive: true })
  const shellRcDir = path.join(userDataDir, "shell-rc")
  await fs.mkdir(shellRcDir, { recursive: true })

  // `ELECTRON_RENDERER_URL` (exported by `electron-vite dev`) would turn the renderer back
  // into http://localhost; `CLAXEDO_DEVTOOLS` opens devtools with it. Neither may vary the
  // lane with the operator's shell.
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key === "ELECTRON_RENDERER_URL" || key === "CLAXEDO_DEVTOOLS") continue
    // Test-runner console formatting must not disable color in the app's PTYs.
    // A test can still request these explicitly through input.env.
    if (key === "NO_COLOR" || key === "FORCE_COLOR" || key === "CLICOLOR_FORCE") continue
    env[key] = value
  }
  env.CLAXEDO_DESKTOP_USER_DATA_DIR = userDataDir
  env.CLAXEDO_DATA_DIR = dataDir
  env.ZDOTDIR = shellRcDir
  if (input.testOnlyHttpsTrust) env.NODE_EXTRA_CA_CERTS = input.testOnlyHttpsTrust.caPath
  Object.assign(env, input.env ?? {})

  const app = await electron.launch({
    executablePath,
    args: [
      `--user-data-dir=${userDataDir}`,
      ...(input.testOnlyHttpsTrust
        ? [`--ignore-certificate-errors-spki-list=${input.testOnlyHttpsTrust.certificateSpki}`]
        : []),
    ],
    env,
    timeout: input.timeoutMs ?? 60_000,
  })

  // Before `waitForShellWindow()`: the last point a context-level init script lands
  // ahead of the shell's first navigation.
  if (input.beforeShellWindow) await input.beforeShellWindow(app.context())

  // Context-level listeners, attached before the shell window resolves: the app finishes
  // its bootstrap fetches while the first window is still being handed over, so a per-page
  // listener added later sees nothing. Main-process output is kept because an app that
  // quits mid-test leaves Playwright saying only "Target page, context or browser has been
  // closed".
  const appLog: string[] = []
  app.process().stdout?.on("data", (chunk) => appLog.push(String(chunk)))
  app.process().stderr?.on("data", (chunk) => appLog.push(String(chunk)))

  const serverResponses: string[] = []
  app.context().on("response", (response) => {
    const url = response.url()
    if (!/^https?:/.test(url)) return
    if (response.status() < 200 || response.status() >= 400) return
    serverResponses.push(url)
  })

  // Not `firstWindow()`: the app opens a splash (`loading.html`) while the embedded
  // server boots, then the real shell (`index.local.html`). `firstWindow()` resolves to the
  // splash, which is destroyed once the shell is ready, and every later interaction dies
  // with "Target page, context or browser has been closed".
  const page = await waitForShellWindow(app, input.timeoutMs ?? 60_000, appLog)
  await page.waitForLoadState("domcontentloaded")

  // Assert the premise rather than trust the env surgery above.
  const protocol = await page.evaluate(() => window.location.protocol)
  expect(
    protocol,
    "GATING: the packaged renderer must be a file:// document — an http(s) renderer means " +
      "ELECTRON_RENDERER_URL leaked into the launch env and this lane cannot see the file:// defect class",
  ).toBe("file:")

  const close = async () => {
    const graceful = app.close().catch(() => {})
    const closed = await Promise.race([
      graceful.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 10_000)),
    ])
    if (!closed) {
      app.process().kill("SIGTERM")
      await Promise.race([graceful, new Promise<void>((resolve) => setTimeout(resolve, 5_000))])
      if (app.process().exitCode === null) app.process().kill("SIGKILL")
    }
    if (!input.preserveUserDataDir) {
      await shutdownPackagedTestDaemon(userDataDir)
      await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  return { app, page, userDataDir, serverResponses, appLog, close }
}

/**
 * A diagnostic, not coverage: the shell renders from the local bundle whether or not the
 * renderer can reach its server, so "the shell rendered" proves nothing about that seam.
 * Real coverage is the first server-touching mutation (session or terminal creation);
 * this fails earlier and names the cause. With the API base resolved to the document,
 * requests go to `file:///api/...` and no 2xx from an http(s) origin is ever observed.
 */
export async function expectServerReachable(packaged: PackagedApp, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = packaged.serverResponses.find((url) => /\/api\/claxedo\/|\/api\/control\/|\/session/.test(url))
    if (hit) return hit
    // A plain timer, not `page.waitForTimeout`: if the app quits mid-poll the page-bound
    // wait throws and hides the diagnostic below.
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(
    "GATING: the packaged renderer never made a successful http(s) request to its server. " +
      "This is the signature of the API base resolving to the document origin (file://) — see " +
      "api.ts's sameOriginForRemoteLocalBackend protocol guard. Observed responses: " +
      (packaged.serverResponses.slice(0, 5).join(", ") || "(none)") +
      "\n--- app log (tail) ---\n" +
      packaged.appLog.join("").split("\n").slice(-25).join("\n"),
  )
}

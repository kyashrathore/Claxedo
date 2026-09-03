/**
 * Launches the PACKAGED Claxedo desktop app for the `desktop-*` e2e lanes.
 *
 * WHY THIS EXISTS — no lane had ever run the packaged app. Every Playwright
 * config points a browser at an `http://localhost` dev server, and four defects
 * shipped to users in v0.0.65 through that blind spot, all four tracing to one
 * fact: *the packaged renderer is a `file://` document*. In a browser on
 * `http://localhost`, `window.location.protocol` is `https?:` and the entire
 * bug class evaporates, so those four were not merely uncaught — they were
 * structurally undetectable. See
 * `docs/plans/2026-08-06-001-test-full-matrix-real-e2e-plan.md`.
 *
 * THE LOAD-BEARING PRECONDITION — `packages/claxedo-desktop/src/main/windows.ts:177-186`:
 *
 *     const devUrl = process.env.ELECTRON_RENDERER_URL
 *     if (devUrl) { win.loadURL(...); return }      // dev  -> http://localhost
 *     win.loadFile(join(root, `../renderer/${html}`)) // packaged -> file://
 *
 * So the rule is NOT "don't launch from source" — it is that
 * `ELECTRON_RENDERER_URL` must be UNSET. A harness that leaks that variable in
 * (it is exported by `electron-vite dev`, so an inherited shell env can carry
 * it) silently downgrades the lane to an http renderer and every one of those
 * four defects becomes invisible again. {@link launchPackagedApp} therefore
 * strips it and then ASSERTS the renderer's real origin before returning,
 * rather than trusting the env manipulation to have worked.
 */

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

// `import.meta.url`, not `__dirname`: this suite is ESM and `__dirname` is not
// defined there — it fails at module load, before any test is collected, with
// "No tests found" as the only visible symptom.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, "../../../..")
const DESKTOP = path.join(REPO_ROOT, "packages/claxedo-desktop")

/**
 * Where `electron-builder --dir` leaves the unpacked app, per platform.
 *
 * `--dir` is used rather than the full `package:mac` path deliberately: it
 * skips DMG creation and notarisation (`package:mac` is ~5 min / 1.4 GB) while
 * still producing an asar-packed app whose renderer loads over `file://` —
 * asar is never disabled in `electron-builder.config.ts` and `asarUnpack` is in
 * use there (line 154), so packing is independent of the target. The `file://`
 * renderer is the whole reason the lane exists, so this shortcut costs nothing
 * that matters.
 */
/**
 * DISCOVERED, not hardcoded. The bundle is named per release channel — a Dev
 * build produces `Claxedo Dev.app` with a `Claxedo Dev` executable inside, not
 * `Claxedo.app`/`Claxedo` (observed 2026-08-06). Pinning the product name would
 * make the lane pass or fail on which channel the operator happened to build,
 * which is exactly the kind of environment coupling that makes a lane
 * untrustworthy.
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
        // The executable inside a .app is the bundle name minus ".app".
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
    "GATING: no packaged desktop binary found. Build one first (measured 2026-08-06: 42s, 403 MB):\n" +
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
 * Boot the packaged app against a scratch profile.
 *
 * `userData` is redirected to a fresh `mkdtemp` on every run, and that is not
 * hygiene theatre: during the 2026-08-05 session a `defaultServerUrl` written
 * while diagnosing persisted into
 * `~/Library/Application Support/@claxedo/desktop/claxedo.settings.json` and
 * produced a "Could not connect to configured server" dialog in later runs —
 * and that store is shared across the release and Dev channels, so a leaked
 * setting crosses builds too. A lane that inherits the developer's real profile
 * is neither reproducible nor safe to run on a workstation.
 *
 * The app boots ITS OWN embedded claxedo-server, which is the production flow
 * and is exactly the seam these lanes exist to exercise. Nothing external is
 * injected except the scripted model endpoint (`env`), which is the one thing
 * the plan permits to be fake.
 */
export async function launchPackagedApp(
  input: {
    /** Extra env for the app — the scripted model endpoint goes here. */
    env?: Record<string, string>
    /** Overrides the default 60s first-window wait; the embedded server boots first. */
    timeoutMs?: number
    /**
     * ADDED for plan Phase 4 (`docs/plans/2026-08-06-001-test-full-matrix-real-e2e-plan.md`,
     * `desktop-signed-*` lanes) — additive and optional, so every Phase-2 call site above is
     * byte-for-byte unaffected. Points the packaged app at an EXTERNAL server instead of its
     * own embedded one: the two signed lanes run against a real `hosted-node` control plane +
     * local JWKS issuer spawned OUTSIDE this process (`signed-browser-relay-fixture.mjs`), not
     * the app's own boot-time server.
     *
     * `CLAXEDO_SERVER_URL` (the env var `setupServerConnection` in `main/index.ts` reads) is
     * NOT the seam for this: that branch is gated `if (!IS_PACKAGED)` — a `--dir` build always
     * has `IS_PACKAGED = !process.defaultApp === true`, so the env var is silently ignored on
     * every packaged binary (verified by reading `main/index.ts:411-424` — the env var lives
     * inside the `!IS_PACKAGED` block, and nothing below it re-reads `process.env` at all). The
     * ONLY seam a packaged build honours is `getSavedServerUrl()` (`main/server.ts`), which
     * reads `store.get("defaultServerUrl")` from an `electron-store` file the MAIN process opens
     * during `initialize()`, before any renderer or IPC channel exists — so it must be written
     * to disk before `electron.launch()`, not pushed in afterward via `window.api.storeSet` the
     * way Phase 2's `openWorkspaceProject` seeds the project list.
     *
     * `electron-store`'s default `cwd` is `app.getPath('userData')`, which `--user-data-dir`
     * (below) pins to this run's own `userDataDir` — so the file lands at
     * `<userDataDir>/claxedo.settings.json`, matching the SAME path the plan's Phase 2 section
     * names as the real, previously-observed persistence location
     * (`~/Library/Application Support/@claxedo/desktop/claxedo.settings.json`) rooted at THIS
     * run's scratch profile instead of a shared one.
     *
     * Not paired with a "make the health check unconditionally pass" affordance: if
     * `serverUrl` isn't reachable yet, `setupServerConnection` -> `checkHealthOrAskRetry` opens
     * a NATIVE `dialog.showMessageBox` prompt that Playwright's Electron driver cannot click,
     * hanging the launch until `timeoutMs`. Callers MUST await their external server's own
     * readiness signal (the fixture's stdout JSON line) before calling this.
     */
    serverUrl?: string
    /**
     * ADDED 2026-08-06 for boot-error-detection coverage
     * (`docs/plans/2026-08-06-001-test-full-matrix-real-e2e-plan.md`,
     * `desktop-unsigned-embedded.spec.ts`'s boot-observer scenario). Additive
     * and optional — every existing call site above is byte-for-byte unaffected
     * when this is omitted.
     *
     * Invoked with the launched app's `BrowserContext` immediately after
     * `electron.launch()` resolves, before EITHER window (splash or shell) is
     * queried. This is the only point at which `context().addInitScript(...)`
     * can still land before the shell's first navigation: this function's own
     * `waitForShellWindow()` below blocks until `index.local.html` has already
     * loaded, so a `Page`-level `addInitScript` call on the page it returns is
     * provably too late — the app's real bootstrap fetches and any boot-time
     * toast have already run by then. `boot-observer.ts`'s `installBootObserver`
     * is the intended caller (it now accepts `Page | BrowserContext` for
     * exactly this reason). Kept as an opt-in hook rather than baking a
     * specific observer in here so this file does not have to know what a
     * caller wants to observe.
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
    // Written BEFORE `electron.launch()` below — see the parameter doc above for why this
    // can't be an IPC call made after boot. Plain flat JSON: electron-store's on-disk shape
    // for a store with no `schema`/`migrations` is exactly `JSON.stringify(store, null, 2)`
    // with no wrapper object, so `{"defaultServerUrl": "..."}` is `store.get("defaultServerUrl")`
    // returning that exact string on first read — verified against `main/server.ts`'s
    // `getDefaultServerUrl()`, which does nothing but `store.get(DEFAULT_SERVER_URL_KEY)`.
    await fs.writeFile(
      path.join(userDataDir, "claxedo.settings.json"),
      JSON.stringify({ defaultServerUrl: input.serverUrl }, null, 2),
    )
  }
  // TWO separate roots have to be isolated, and missing the second one is not a
  // theoretical hazard — it was measured on 2026-08-06. Electron's
  // `--user-data-dir` moves only the renderer/browser profile; the embedded
  // claxedo-server keeps its own store at `CLAXEDO_DATA_DIR`, takes an
  // exclusive lock on it, and refuses to start when another process holds it:
  //
  //     code: 'data_dir_already_owned', status: 409, retryable: false,
  //     owner: { pid: 62177, ... }
  //     -> "The embedded Claxedo server did not become healthy in time."
  //
  // With only `--user-data-dir` isolated, the lane therefore fails on any
  // machine that happens to be running Claxedo — a dev server, or the user's
  // own installed app. That is a false red that would train people to ignore
  // this lane, so the server's data root is scratched per run as well.
  // THIRD ROOT — the cause of the "Failed to load sessions for opencode /
  // 404 / 503" toast pair seen on EVERY desktop run (2026-08-06; confirmed
  // across 245 evidence screenshots in e2e/EVIDENCE-AUDIT.md).
  //
  // `--user-data-dir` is INERT for this app. claxedo-desktop/src/main/index.ts:34
  // explicitly overrides it:
  //     app.setPath("userData",
  //       process.env.CLAXEDO_DESKTOP_USER_DATA_DIR ??
  //         join(app.getPath("appData"), … "ai.claxedo.desktop.dev"))
  // so the Chromium flag loses to that call and the app keeps reading the real
  // channel store at
  //   ~/Library/Application Support/ai.claxedo.desktop.dev/opencode.global.dat.json
  // which already lists the developer's own repo checkout as a project. The
  // app then asked its FRESH scratch server for a directory that server had
  // never registered -> 404, then 503, then stacked error toasts at boot.
  //
  // Verified this was NOT a hardcoded default: no such path exists in
  // claxedo-desktop/src, in electron-builder.config.ts, or in the built
  // app.asar (all three grepped). It was inherited persisted state.
  //
  // `CLAXEDO_DESKTOP_USER_DATA_DIR` is the app's own supported seam for this,
  // so no product change is needed — but it MUST be set, and the
  // `--user-data-dir` arg below is kept only because Chromium's own cache
  // paths still honour it.
  const dataDir = path.join(userDataDir, "server-data")
  await fs.mkdir(dataDir, { recursive: true })
  // FOURTH ROOT — the interactive shell a terminal in this app spawns.
  //
  // A terminal launched from the packaged app runs the operator's own `$SHELL`
  // with the operator's own rc files, and those rc files write to, and read
  // from, the same PTY a spec types into. Measured 2026-09-03: oh-my-zsh's
  // periodic "Would you like to update? [Y/n]" prompt was on screen when
  // `desktop-unsigned-embedded`'s D1/D3 typed `echo "CLAXEDO_PORT_CHECK=..."`,
  // so zsh handed the leading `e` to that prompt and ran `cho …` instead —
  // reported as "the terminal's $CLAXEDO_PORT never echoed the real port" while
  // the port was never actually asked for. The same rc set `correct`, which then
  // asked about `cho` too.
  //
  // So the shell's startup files are isolated the way `userData` and
  // `CLAXEDO_DATA_DIR` already are: `ZDOTDIR` points at an empty directory, and
  // zsh reads its startup files from there instead of the operator's `$HOME`.
  // `HOME` itself is deliberately left alone — the real git identity, the real
  // `claude` credential and the real PATH are what make this lane's harnesses
  // real.
  const shellRcDir = path.join(userDataDir, "shell-rc")
  await fs.mkdir(shellRcDir, { recursive: true })

  // Strip, never merely omit. `ELECTRON_RENDERER_URL` is exported by
  // `electron-vite dev`, so a developer running the dev server in the same
  // shell would otherwise hand it to the packaged app and silently turn the
  // renderer back into `http://localhost` — the exact condition that makes this
  // lane worthless. `CLAXEDO_DEVTOOLS` is dropped for the same class of reason:
  // it opens devtools only when the dev URL is present, and a lane should not
  // vary with the operator's shell.
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key === "ELECTRON_RENDERER_URL" || key === "CLAXEDO_DEVTOOLS") continue
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

  // MUST run before `waitForShellWindow()` below, for the same reason the
  // response listener two blocks down does: this is the earliest point at
  // which the app's `BrowserContext` exists, and therefore the last point at
  // which a context-level `addInitScript` can still precede the shell's first
  // navigation. See the `beforeShellWindow` parameter doc above.
  if (input.beforeShellWindow) await input.beforeShellWindow(app.context())

  // Recorded at the CONTEXT level and attached before `firstWindow()` resolves,
  // because a per-page listener attached afterwards races the app and loses:
  // the packaged app finishes its bootstrap fetches while the first window is
  // still being handed over, so a listener added later observes nothing and the
  // check fails against a perfectly healthy app (measured 2026-08-06 — the app
  // had rendered its project list and A1 still saw zero responses).
  // Main-process output is captured because an Electron app that quits during a
  // test leaves Playwright saying only "Target page, context or browser has been
  // closed", which names the symptom and hides every cause. The app's own log
  // says why.
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

  // NOT `firstWindow()`. The desktop app opens TWO windows: a splash
  // (`loading.html`, windows.ts:171) while the embedded server boots, and then
  // the real shell (`index.local.html`, windows.ts). `firstWindow()` resolves to
  // the SPLASH, which is destroyed the moment the shell is ready — so every
  // subsequent interaction dies with "Target page, context or browser has been
  // closed" about two seconds in (measured 2026-08-06). Worse, an assertion
  // that only inspects recorded state rather than touching the page still goes
  // GREEN against that dead handle, which is precisely the pass-while-broken
  // shape INVARIANTS.md forbids. So wait for the shell explicitly.
  const page = await waitForShellWindow(app, input.timeoutMs ?? 60_000, appLog)
  await page.waitForLoadState("domcontentloaded")

  // ASSERT the premise rather than trusting the env surgery above. If this ever
  // fails the lane is testing a different application than it claims to, and
  // every "green" below it is meaningless — so it fails loudly and early.
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
      await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  return { app, page, userDataDir, serverResponses, appLog, close }
}

/**
 * Scenario A1 — the transport tripwire.
 *
 * DELIBERATELY A DIAGNOSTIC, NOT COVERAGE. "The shell rendered" would have been
 * green through every one of the four packaged defects: the shell renders from
 * the local bundle, so it proves nothing about the seam between the renderer
 * and the server. The owner's own account is the evidence — the app booted
 * fine, and breakage only surfaced on CREATING A SESSION or CREATING A
 * TERMINAL. Real coverage therefore lives on the first server-touching
 * mutation (scenarios B1 and D1); this exists only because it fails earlier and
 * names the cause more precisely than they do.
 *
 * The assertion that actually bites: with the API base wrongly resolved to the
 * document, requests go to `file:///api/...` and no 2xx from an http(s) origin
 * is ever observed.
 */
export async function expectServerReachable(packaged: PackagedApp, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = packaged.serverResponses.find((url) => /\/api\/claxedo\/|\/api\/control\/|\/session/.test(url))
    if (hit) return hit
    // A PLAIN timer, not `page.waitForTimeout`: if the app quits mid-poll the
    // page-bound wait throws "Target page, context or browser has been closed"
    // and destroys the diagnostic — the caller then sees only that symptom
    // instead of the GATING message and the app log below, which name the cause.
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

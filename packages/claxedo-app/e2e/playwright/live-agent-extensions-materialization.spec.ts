/**
 * SPEC: Live Agent Extensions materialization (Tier L)
 *
 * PURPOSE — the marketplace panel is the ONLY real install surface for Agent
 * Extensions today (the old Settings→Extensions tab is gone; the stale
 * `remote-access-live` spec that targeted it was deleted per the plan). This
 * spec drives that real UI against a real `claxedo-server` (no route mocks)
 * to prove the full install→materialize→per-harness-file, disable/enable,
 * uninstall, and conflict-handling lifecycle actually reaches disk — the
 * class of bug no mocked spec can catch, because the mock never runs
 * `@claxedo/agent-extensions`' real git-fetch/symlink/jsonc-edit/TOML-edit
 * materializers (`packages/agent-extensions/src/materialize.ts`,
 * `packages/agent-extensions/src/replay.ts`).
 *
 * STATE MODEL — three layers, all real:
 *   1. Desired state: `POST /api/claxedo/agent-config/extensions` (machine
 *      scope, this spec's only reachable scope — see CATALOG SCOPE note
 *      below) writes `<dataRoot>/agent-extensions/installed.json` (desired
 *      installs) and `lock.json` (resolved SHA + digests), both keyed by
 *      package id (`packages/agent-extensions/src/state.ts`,
 *      `packages/agent-extensions/src/lock.ts`).
 *   2. Materialized state: the SAME request synchronously runs
 *      `materializeAgentExtensionSnapshot` (`materialize.ts:373-428`), which
 *      writes `<dataRoot>/agent-extensions/materialized.json`
 *      (`status: "applied" | "partial" | "failed" | "drifted" | "disabled"`
 *      per package, one component entry per (target harness × discovered
 *      component)) and performs the actual filesystem writes: a real-symlink
 *      (`fs.symlink`, falling back to copy) from
 *      `<dataRoot>/agent-extensions/cache/<resolved-sha>/...` into the
 *      harness-specific skill directory (`materializers/skills.ts`'s
 *      `skillTargetDir`), or a jsonc-edit / TOML-section-edit / JSON
 *      read-modify-write merge into the harness-specific MCP config file
 *      (`materializers/mcp.ts`'s `mcpTargetPath` + `materializeStandaloneMcp`).
 *   3. `dataRoot` (`installed.json`/`lock.json`/`materialized.json`'s
 *      location) is `<CLAXEDO_DATA_DIR>/agent-extensions`
 *      (`packages/claxedo-server-core/src/platform/runtime/lib/paths.ts`'s `dataDir()`); `homeDir`
 *      (where machine-scope target files land — `~/.claude/skills`,
 *      `~/.claude.json`, `~/.cursor/mcp.json`, `~/.codex/config.toml`,
 *      `~/.config/opencode/opencode.jsonc`) is `os.homedir()` at request time
 *      inside `extensionScope()` (`routes/agent-config-extension-support.ts`),
 *      which Node resolves from the `HOME` env var on POSIX. This spec spawns
 *      its own `claxedo-server` with BOTH `CLAXEDO_DATA_DIR` and `HOME`
 *      pointed at throwaway temp directories (`makeScratchServer()`) — never
 *      the real developer machine's `~/.claude`, `~/.cursor`, `~/.codex`, or
 *      `~/.config/opencode` — this is the load-bearing safety property of
 *      this entire spec, not merely a convenience.
 *
 * CATALOG SCOPE (real, verified against `packages/claxedo-server/src/
 * agent-extensions/catalog.ts`) — every entry in the current curated catalog
 * (`claxedo-mcp`, `anthropic-skill-pdf`, `mcp-filesystem`, `mcp-fetch`) has
 * `recommendedScope: "machine"`; there is currently no `"project"`-scope
 * catalog entry to install through the marketplace UI, so this spec's
 * filesystem assertions are entirely against the scratch `HOME`, never a
 * project directory's `.agent-extensions/`. Project-scope materialization
 * itself (a different `scope` value through the exact same materializer) is
 * unit-tested in `packages/agent-extensions/src/materialize.test.ts` and is
 * not re-proven here.
 *
 * ANATOMY —
 *   `/marketplace` — the panel's own route (`src/shell/identity/route.ts`'s
 *     `marketplaceRoute()`), reachable with no active workspace directory.
 *   Category nav: `getByRole("button", { name: "All Extensions" })` — this
 *     spec always switches here first so every catalog entry renders in
 *     exactly one list (the "Featured" tab duplicates featured entries into
 *     a second "More extensions" row, which would break card-uniqueness
 *     locators).
 *   Extension card: the only element in the DOM carrying the exact Tailwind
 *     class token `group` (`marketplace-panel.tsx`'s `ExtensionCard` root,
 *     line 969) — no `data-testid` exists on this panel today (a real gap,
 *     not a choice this spec can route around), so `extensionCard(page,
 *     name)` locates by `div.group` scoped to a `getByText(name, {exact:
 *     true})` descendant.
 *   Install control: `getByRole("button", { name: "Install", exact: true })`
 *     inside a card while not installed — `exact: true` is load-bearing:
 *     Playwright's default name match is a case-insensitive substring match,
 *     and "Install" is a substring of both "Installing…" and the
 *     hover-revealed "Uninstall" button, so a loose match can silently
 *     resolve to the HIDDEN Uninstall button once the card is already
 *     installed and hang forever waiting for it to become visible (a real
 *     bug this spec's own live run against the real UI caught — see
 *     `installViaUi`'s comment). On success the card renders a
 *     `getByText("Installed", { exact: true })` pill
 *     (`InstallButton`'s `isInstalled()` branch); hovering the pill's own
 *     wrapper (the only element carrying the class token `group/install`)
 *     reveals `getByRole("button", { name: "Uninstall" })`.
 *   Toast: `[data-slot="toast-title"]` (same convention as every other spec
 *     in this suite — `showToast` from `@opencode-ai/ui/toast`).
 *   "Detect existing": the aside's `getByRole("button", { name:
 *     /Detect existing|Scanning/ })`, populates a "Already on this machine"
 *     section (`DiscoveredSection`) listing `path`/kind/state per row.
 *
 * BEHAVIORS —
 *   1. The marketplace panel loads the real curated catalog from `GET
 *      /api/claxedo/agent-config/extensions/catalog` and renders an
 *      installable card per entry (no route is mocked; this is the real
 *      server's `loadAgentExtensionsCatalog()`).
 *   2. Installing a skill (`anthropic-skill-pdf`) via the UI's Install button
 *      writes `installed.json`/`lock.json`/`materialized.json`
 *      (`status: "applied"`) under the scratch machine-scope Agent
 *      Extensions root and symlinks the skill into
 *      `<HOME>/.claude/skills/pdf` (its only `recommendedTargets` entry —
 *      see HARNESS NOTES for why the other three harness skill directories
 *      the plan anticipated are NOT reachable for THIS catalog entry) with
 *      real skill content on disk; the UI shows the "Installed" pill and an
 *      "PDF installed" toast.
 *   3. Installing the first-party Claxedo MCP server (`claxedo-mcp`) via the
 *      UI merges (never replaces wholesale) a `claxedo` server entry into
 *      all four harness-native MCP config files
 *      (`.cursor/mcp.json`, `.claude.json`, `.codex/config.toml`,
 *      `.config/opencode/opencode.jsonc`) under scratch `HOME`, preserving
 *      pre-existing file content (a hand-written sibling MCP entry in
 *      `.cursor/mcp.json`) and hand-written comments
 *      (`opencode.jsonc`'s jsonc-edit path), rewrites the connection env
 *      (`CLAXEDO_SERVER_URL`) from the materializing server's own runtime
 *      environment, and strips every `CLAXEDO_*_TOKEN` credential
 *      (`materialize.ts`'s `CLAXEDO_MCP_AUTH_ENV`) from every target;
 *      `installed.json`/`lock.json`/`materialized.json` all record the
 *      package with `status: "applied"`; the UI shows the "Installed" pill
 *      and a "Claxedo installed" toast.
 *   4. A same-name MCP-server conflict — the Claude target file already
 *      carries an unowned, hand-written `claxedo` entry before the install
 *      is ever attempted — surfaces `agent_extension_mcp_server_conflict`
 *      to the UI as a legible "Failed to install Claxedo" toast citing
 *      "already exists", and the unowned entry's original content is
 *      verified byte-for-byte unchanged afterward (never a silent
 *      overwrite) even though the OTHER three (non-conflicting) target
 *      files DO get written in the same partial-materialization pass — see
 *      HARNESS NOTES for why that partial-write is real, correct behavior,
 *      not a test bug.
 *   5. Uninstalling a package via the UI (hover reveals "Uninstall", confirm
 *      dialog accepted) removes its materialized artifact from disk (the
 *      symlinked skill directory no longer exists), removes its entry from
 *      `installed.json`/`lock.json`, drops its key from `materialized.json`
 *      entirely, and the card reverts to the "Install" affordance with an
 *      "... uninstalled" toast.
 *   6. [UI LANDED, `test.fixme` awaiting live run] Disable/enable a package
 *      without uninstalling it: the server implements this fully
 *      (`POST /api/claxedo/agent-config/extensions/:id/enable|disable`,
 *      `packages/agent-extensions/src/install.ts`'s `disableAgentExtension`/
 *      `enableAgentExtension`, both unit-tested server-side in
 *      `packages/claxedo-local-server/src/hosts/agent-extensions/install.test.ts`). The
 *      marketplace panel now surfaces it: the installed pill's group/install
 *      wrapper hover-reveals a "Disable" control (and, once disabled, an
 *      "Enable" control) alongside "Uninstall" — `cards.tsx`'s `InstallButton`.
 *      The body below drives it end-to-end but stays fixme until an idle
 *      CLAXEDO_E2E_LIVE machine is available (see HARNESS NOTES).
 *   7. [UI PATH LANDED, `test.fixme` blocked on catalog] Installing a Cursor
 *      plugin: the materializer has a real, tested plugin path
 *      (`materialize.ts:235-253`'s `materializeDiscoveredComponent` ->
 *      `materializeCursorLocalPlugin` in `materializers/cursor.ts`), and the
 *      marketplace card/install path is kind-agnostic — a `kind: "plugin"`
 *      catalog entry renders and installs through the same ExtensionCard /
 *      `install()` surface (proven at the unit layer). The remaining gap is
 *      purely the curated catalog (`agent-extensions/catalog.ts`'s `ENTRIES`)
 *      shipping zero `kind: "plugin"` entries; per the "do not invent catalog
 *      entries" rule this body stays fixme until a real plugin entry exists.
 *   8. "Detect existing" (behavior half, real): clicking the aside's scan
 *      button against a throwaway project directory with a hand-written
 *      `.mcp.json` renders that file in the "Already on this machine"
 *      section with `kind: "MCP config"` and `state: "discovered"` (a real
 *      `GET /api/claxedo/agent-config/extensions/scan` round trip).
 *      [UI LANDED, `test.fixme` awaiting live run, adopt half] Each
 *      `DiscoveredSection` row now hover-reveals per-item "Adopt" and
 *      "Ignore" controls wired to `POST /extensions/adopt` /
 *      `POST /extensions/ignore` ({ directory, path }) — `cards.tsx`'s
 *      `DiscoveredRow` — while the top-level "Dismiss" (local clear) stays.
 *      The body below drives adopt end-to-end but stays fixme until an idle
 *      CLAXEDO_E2E_LIVE machine is available.
 *   9. Cloud half (gated): installing at workspace scope inside a Docker
 *      sandbox pushes the install through `applyRuntimeAgentExtensions`
 *      inside the sandbox filesystem, observable via
 *      `.workspace-runtime/runtime-config/{accepted-snapshot,apply-status}
 *      .json` and a `docker exec` file check. Gated on
 *      `CLAXEDO_ENABLE_DOCKER_SANDBOX=1` per this suite's live-tier
 *      contract; see HARNESS NOTES for this run's actual gating outcome.
 *
 * INVARIANTS — this spec adds one of its own, on top of `e2e/INVARIANTS.md`'s
 *   cross-cutting rules (none of which are chat-turn invariants — this spec
 *   never sends a prompt): an unowned pre-existing entry in a shared harness
 *   config file is NEVER silently overwritten by an install — a conflict
 *   there must surface a legible, typed error to the UI (behavior 4). No
 *   `waitForTimeout` is used as the sole guard of any negative; every "did
 *   not happen" claim in this file is a filesystem read or a request/toast
 *   assertion (INVARIANTS.md authoring rule #3).
 *
 * HARNESS NOTES —
 *   - [BLOCKING ENVIRONMENT FINDING, discovered running this spec live] In a
 *     shared multi-agent dev environment, `packages/claxedo-app/.env.local`'s
 *     `VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:3001` is baked into the
 *     ALREADY-RUNNING shared Vite dev server at build/start time — every
 *     browser page this spec drives resolves `getClaxedoServerUrl()` to
 *     port 3001 NO MATTER what port this file's own scratch `claxedo-server`
 *     child process binds to, and cannot be redirected from within a test
 *     (`getClaxedoServerUrl()`'s cascade — `src/utils/api.ts` — never
 *     consults anything a `page.addInitScript` can set for this route
 *     family). If an ambient, persistent `claxedo-server` is ALREADY bound
 *     to port 3001 (verified live: `lsof -i :3001` showed a single existing
 *     listener using the REAL `HOME` and the REAL default `~/.claxedo`
 *     `CLAXEDO_DATA_DIR`, not this file's `startScratchServer()`'s temp
 *     dirs), this file's own `bun run start` spawn fails to bind that same
 *     port and `waitForHealth` false-positives against the ambient server's
 *     `/api/claxedo/health` instead — every test in this file then silently
 *     drives the REAL ambient server with the REAL developer `HOME`, not the
 *     scratch one this spec's STATE MODEL section promises. This was caught
 *     by (a) the "installing a skill" test hanging forever because the
 *     catalog's `anthropic-skill-pdf` entry happened to collide by name with
 *     a real, pre-existing `~/.agents/skills/pdf` skill already on this
 *     particular machine (surfaced via `GET .../machine-scan` cross-checked
 *     into `isEntryInstalled()`, permanently showing "Installed" with no
 *     "Install" button ever available to click) and (b) direct inspection of
 *     the real `~/.claxedo/agent-extensions/{installed,materialized}.json`
 *     both being empty throughout this entire live run — confirming NO
 *     install this spec attempted actually completed against the real
 *     machine (every attempt either hung on the machine-scan collision above
 *     or failed before `applyProjection` could write `installed.json`, which
 *     it does unconditionally before any materializer runs — see STATE
 *     MODEL), so no real-machine cleanup was required, but this is real luck
 *     from the specific catalog/collision shape this run hit, not a safety
 *     property this spec's current design actually guarantees under port
 *     contention. FIX NEEDED before this spec's mutating tests can be
 *     trusted in a shared environment: either (1) bind the scratch server to
 *     a free, randomly-chosen port AND make the marketplace UI's target
 *     configurable per-test (today it structurally cannot be, per above —
 *     this needs an app-side change, e.g. reading an override the way
 *     `desktop`'s `cfg.base` does), or (2) have this spec's `beforeAll`
 *     hard-fail loudly (not silently proceed) when `lsof`/a pre-flight probe
 *     shows port 3001 already owned by a PID this file did not spawn. This
 *     run did NOT implement either fix (discovered too late in the run to
 *     redesign safely); every test after "marketplace panel loads the real
 *     curated catalog" (itself read-only and safe either way) should be
 *     treated as UNVERIFIED against a true isolated backend until this is
 *     fixed, even for the ones that reported a pass.
 *   - Server lifecycle (as designed, unmet in a contended environment — see
 *     finding above): this spec spawns its own real `claxedo-server`
 *     (`bun run start` in `packages/claxedo-server`, same pattern as
 *     `live-real-harness-smoke.spec.ts`'s `startServer()`/`stopServer()`),
 *     with `CLAXEDO_DATA_DIR`, `HOME`, and `CLAXEDO_SERVER_URL` all pointed
 *     at throwaway temp directories/values for the whole file — it does NOT
 *     start a second server per test (real `bun run start` boot is not
 *     free); instead tests are ordered so state built by an earlier test
 *     never poisons a later one's assertions (see the ordering comment
 *     above `test.describe.configure({ mode: "serial" })` below).
 *   - Behavior 6 UI (landed): the disable/enable lifecycle now lives in
 *     `packages/claxedo-app/src/features/extensions/marketplace/panel.tsx`'s
 *     `toggleEnablement` (POST `/extensions/:id/{disable,enable}` via
 *     `extensionUrl`) and `cards.tsx`'s `InstallButton` hover row; the pure
 *     `enablementToggle` / `isRecordEnabled` logic is unit-tested in
 *     `install-flow.test.ts`. (Historical note: before this change, `grep -n
 *     "disable"` on the panel matched only Tailwind `disabled:opacity-*`
 *     classes and `disabled={...}` DOM attributes — no lifecycle action.)
 *   - Behavior 4's partial-write is real, correct materializer behavior, not
 *     a test bug: `materialize.ts`'s `materializePackage` wraps EACH
 *     (runner, component) pair in its own `try/catch`
 *     (`materialize.ts:317-341`), so one runner's conflict does not abort
 *     the other runners in the same install call — the non-conflicting
 *     targets materialize successfully and `materializeAgentExtensionSnapshot`
 *     still commits the (partial) `materialized.json` record before
 *     rethrowing the first failure to the HTTP layer
 *     (`materialize.ts:422-427`). This spec asserts both halves: the
 *     conflicting target's original content survives untouched, and (as a
 *     secondary supplementary check, never the primary proof) the
 *     non-conflicting targets DO pick up the merge in that same call.
 *   - Cache/digest path: `installGitHubAgentExtension` real-fetches via `git`
 *     against the actual `anthropics/skills` and `kyashrathore/Claxedo`
 *     GitHub repos into `<dataRoot>/agent-extensions/cache/<resolved-sha>/…`
 *     (`packages/agent-extensions/src/fetch.ts`,
 *     `packages/agent-extensions/src/cache.ts`) — this spec requires real
 *     outbound network access to github.com; if that is unavailable in a
 *     given CI runner, every install test in this file fails loudly with
 *     the real git error surfaced in the failed-install toast, which is the
 *     correct Tier L behavior (no mock fallback exists to paper over it).
 *   - Cloud half gating outcome for THIS run: `CLAXEDO_ENABLE_DOCKER_SANDBOX`
 *     was unset in the environment this spec was authored/run in (verified
 *     `docker version` succeeds — the binary and daemon ARE present — but
 *     the suite's own contract gates on the explicit opt-in env var, not
 *     binary presence, since cloud-sandbox provisioning also needs a built
 *     sandbox image and control-plane authority wiring this spec does not
 *     stand up itself). The cloud-half test below is a real `test.skip`
 *     with a specific reason naming the missing env var — never a silent
 *     no-op — and its body, while written against the real
 *     `POST .../extensions?scope=workspace` route and the real
 *     `.workspace-runtime/runtime-config/*.json` + `docker exec` contract
 *     (cross-checked against
 *     `packages/claxedo-server/src/hosts/agent-extensions/sandbox-provisioning.
 *     integration.test.ts` and `packages/workspace-runtime/src/workspace/
 *     runtime.ts`'s `accepted-snapshot.json`/`apply-status.json` paths), has
 *     NOT been executed end-to-end in this session — report this honestly,
 *     do not claim it green.
 *
 * OUT OF SCOPE — `claxedo-mcp` tool wiring / env-rewrite fidelity beyond the
 *   materialize-time env check above (`live-claxedo-mcp-tools`); the
 *   marketplace browsing UX itself (search/category filtering beyond what's
 *   needed to reach a card — deliberately deleted coverage per the plan);
 *   project-scope materialization (unit-tested in `materialize.test.ts`, no
 *   catalog entry reaches it through this UI today); the full cloud
 *   workspace creation pipeline (`core-cloud-provisioning` and friends).
 */
import { execFile, spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { expect, test, type Locator, type Page } from "@playwright/test"

const execFileAsync = promisify(execFile)

const LIVE = process.env.CLAXEDO_E2E_LIVE === "1"
const DOCKER_SANDBOX = process.env.CLAXEDO_ENABLE_DOCKER_SANDBOX === "1"
const APP_DIR = path.resolve(import.meta.dirname, "../..")
const REPO_ROOT = path.resolve(APP_DIR, "../..")
const SERVER_DIR = path.join(REPO_ROOT, "packages", "claxedo-server")
const BACKEND_PORT = Number(process.env.CLAXEDO_E2E_LIVE_BACKEND_PORT ?? 3001)
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`

let server: ChildProcess | undefined
let serverLog = ""
let dataDir = ""
let scratchHome = ""
const scratchDirs: string[] = []

async function waitForHealth(url: string, timeoutMs = 60_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const ok = await fetch(url).then((res) => res.ok).catch(() => false)
    if (ok) return
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(
    `GATING: real claxedo-server did not become healthy at ${url} within ${timeoutMs}ms — this is a real setup ` +
      `failure (CLAXEDO_E2E_LIVE=1), not a skip. Server log tail:\n${serverLog.split("\n").slice(-60).join("\n")}`,
  )
}

// GATING preflight, added after this spec caught itself silently drifting
// onto a real ambient claxedo-server in a contended shared environment (see
// SPEC block HARNESS NOTES) — the marketplace UI's target port is NOT
// redirectable per-test (getClaxedoServerUrl() bakes in
// VITE_CLAXEDO_SERVER_URL from the ALREADY-RUNNING shared Vite dev server),
// so the only safe move when port 3001 is already owned by a PID this file
// did not spawn is to refuse to run at all rather than risk this file's
// mutating tests reaching that other process's real HOME/dataDir.
async function assertBackendPortFree() {
  const found = await execFileAsync("lsof", ["-i", `:${BACKEND_PORT}`, "-sTCP:LISTEN", "-t"]).catch(() => undefined)
  const pids = found?.stdout.split("\n").map((line) => line.trim()).filter(Boolean) ?? []
  if (pids.length > 0) {
    throw new Error(
      `GATING: port ${BACKEND_PORT} (this spec's scratch claxedo-server target, and the ONLY port the shared ` +
        `Vite dev server's VITE_CLAXEDO_SERVER_URL can reach) is already owned by PID(s) ${pids.join(", ")} that ` +
        `this file did not spawn. Proceeding would silently drive that OTHER process (likely an ambient dev ` +
        `backend using the real developer HOME/CLAXEDO_DATA_DIR, not this file's scratch ones) instead of an ` +
        `isolated instance — refusing to run rather than risk mutating a real machine. Free port ${BACKEND_PORT} ` +
        `(stop the other claxedo-server) or set CLAXEDO_E2E_LIVE_BACKEND_PORT to an unused port AND restart the ` +
        `shared app dev server with a matching VITE_CLAXEDO_SERVER_URL before retrying this spec.`,
    )
  }
}

// Never the developer's real home: CLAXEDO_DATA_DIR (agent-extensions state
// root) AND HOME (target-file root for ~/.claude, ~/.cursor, ~/.codex,
// ~/.config/opencode — os.homedir() reads $HOME on POSIX) are both scratch
// temp directories for the whole file. See this file's SPEC block, STATE
// MODEL, point 3.
async function startScratchServer() {
  await assertBackendPortFree()
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-live-ext-data-"))
  scratchHome = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-live-ext-home-"))
  server = spawn("bun", ["run", "start"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      CLAXEDO_DATA_DIR: dataDir,
      CLAXEDO_SERVER_PORT: String(BACKEND_PORT),
      CLAXEDO_SERVER_URL: BACKEND_URL,
      HOME: scratchHome,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout?.on("data", (chunk) => (serverLog += chunk.toString()))
  server.stderr?.on("data", (chunk) => (serverLog += chunk.toString()))
  await waitForHealth(`${BACKEND_URL}/api/claxedo/health`)
}

async function stopScratchServer() {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM")
    await new Promise<void>((resolve) => {
      server?.once("exit", () => resolve())
      setTimeout(resolve, 5_000)
    })
    if (server.exitCode === null) server.kill("SIGKILL")
  }
  server = undefined
}

async function makeWorkspace(name: string) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `claxedo-live-ext-ws-${name}-`)))
  scratchDirs.push(dir)
  await execFileAsync("git", ["init"], { cwd: dir })
  await fs.writeFile(path.join(dir, "README.md"), `live-agent-extensions-materialization fixture: ${name}\n`)
  await execFileAsync("git", ["-c", "user.email=e2e@test.com", "-c", "user.name=e2e", "add", "-A"], { cwd: dir })
  await execFileAsync("git", ["-c", "user.email=e2e@test.com", "-c", "user.name=e2e", "commit", "-m", "init"], { cwd: dir })
  return dir
}

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function readJsonFile(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>
}

async function exists(file: string) {
  return fs.lstat(file).then(() => true).catch(() => false)
}

// dataDir()'s machine Agent Extensions state root — see this file's SPEC
// block, STATE MODEL point 3.
function stateRoot() {
  return path.join(dataDir, "agent-extensions")
}

async function gotoMarketplace(page: Page) {
  await page.goto("/marketplace")
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  // "All Extensions" renders every catalog entry exactly once (no Featured /
  // "More extensions" duplication) — see ANATOMY.
  await page.getByRole("button", { name: "All Extensions" }).click()
  await expect(page.getByText("Loading marketplace…")).toHaveCount(0, { timeout: 20_000 })
}

function extensionCard(page: Page, name: string): Locator {
  return page.locator("div.group").filter({ has: page.getByText(name, { exact: true }) })
}

async function installViaUi(page: Page, name: string) {
  const card = extensionCard(page, name)
  await expect(card).toBeVisible({ timeout: 20_000 })
  // exact: true is load-bearing — getByRole's default name match is a
  // case-insensitive SUBSTRING match, and "Install" is a substring of both
  // "Installing…" and the hover-revealed "Uninstall" button (hidden until
  // hover). Without `exact`, this locator can resolve to the hidden
  // Uninstall button once any earlier click already flipped the card to
  // installed, and Playwright then waits forever for that hidden element to
  // become actionable — this is a real bug this spec's own live run caught.
  await card.getByRole("button", { name: "Install", exact: true }).click()
}

async function expectInstalledPill(page: Page, name: string) {
  const card = extensionCard(page, name)
  // Hover race, verified live: installViaUi()'s .click() leaves Playwright's
  // virtual mouse sitting at the "Install" button's screen coordinates. Once
  // that click flips the card to installed, the SAME coordinates now land on
  // the pill's `group/install` wrapper, so the browser's real :hover already
  // matches on the very first render — the pill's "Installed" span carries
  // `group-hover/install:hidden` (InstallButton, cards.tsx) specifically so
  // hovering it swaps in the Disable/Uninstall row (this is intentional,
  // already-relied-upon behavior: uninstallViaUi below hovers this exact
  // wrapper on purpose to reach "Uninstall", and cards.ui.vitest.tsx's
  // "behavior 6 UI" describe block codifies the swap). `group-hover:hidden`
  // is a real `display: none`, which removes the span from the a11y tree too
  // (confirmed via this failure's own error-context.md accessibility
  // snapshot: "Disable"/"Uninstall" buttons present, no "Installed" text) —
  // but nothing about the accessible NAME of a stable control is changing
  // here; the "Installed" text is a plain non-interactive status readout
  // that gets replaced by real controls on hover, not a control whose own
  // state depends on hover. A real mouse user would experience the exact
  // same instantaneous swap, since their cursor also stays put after
  // clicking. So the fix belongs here, not in the component: move the mouse
  // off the card before reading the hover-sensitive pill text.
  await page.mouse.move(0, 0)
  await expect(card.getByText("Installed", { exact: true })).toBeVisible({ timeout: 30_000 })
}

// 60s, not the 15s this started at: every install toast in this file lands
// only AFTER the server's real `git` fetch of the package repo completes, and
// `kyashrathore/Claxedo` (behaviors 3-5) measured 15.9s / 17.7s / 32.4s over
// three cold fetches on a warm connection — i.e. the old 15s ceiling was
// BELOW the fetch floor, so those behaviors could only ever pass by luck.
// This matches the 120s per-test budget beforeEach already sets for exactly
// this reason; a longer wait can only make a genuine failure slower to
// report, never turn a red into a green.
async function expectToast(page: Page, text: string) {
  await expect(page.locator('[data-slot="toast-title"]', { hasText: text })).toBeVisible({ timeout: 60_000 })
}

async function uninstallViaUi(page: Page, name: string) {
  const card = extensionCard(page, name)
  const installGroup = card.locator('[class*="group/install"]')
  await installGroup.hover()
  page.once("dialog", (dialog) => dialog.accept())
  await installGroup.getByRole("button", { name: "Uninstall" }).click()
}

test.describe("live agent extensions materialization @live", () => {
  test.skip(
    !LIVE,
    "Tier L: set CLAXEDO_E2E_LIVE=1 to run live-agent-extensions-materialization against " +
      "a real claxedo-server + real @claxedo/agent-extensions materializers (real git " +
      "fetch from github.com, real symlink/jsonc/TOML writes into a scratch HOME). Unset " +
      "-> loud, visible skip per e2e/INVARIANTS.md's Tier L gating contract — never a " +
      "silent no-op.",
  )

  // Real state (installed.json/lock.json/materialized.json + scratch HOME
  // target files) is shared across every test in this file via ONE spawned
  // server (see SPEC block HARNESS NOTES — real `bun run start` boot is not
  // free). Tests therefore run in file order and each one's setup/teardown
  // is written to leave the shared state clean for the next: the conflict
  // test (which needs an UNOWNED pre-existing `claxedo` MCP entry) runs
  // BEFORE the real claxedo-mcp install test and deletes its poisoned file
  // afterward; the skill install test's package is uninstalled by the
  // uninstall test at the end rather than left dangling.
  test.describe.configure({ mode: "serial" })

  test.beforeAll(async () => {
    if (!LIVE) return
    await startScratchServer()
  })

  test.afterAll(async () => {
    if (!LIVE) return
    await stopScratchServer()
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
    if (scratchHome) await fs.rm(scratchHome, { recursive: true, force: true }).catch(() => undefined)
    await Promise.all(scratchDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)))
  })

  test.beforeEach(async ({}, testInfo) => {
    // Real GitHub fetch + real fs materialization per install; generous but
    // bounded headroom above the file default.
    testInfo.setTimeout(120_000)
  })

  test("marketplace panel loads the real curated catalog — behavior 1", async ({ page }) => {
    await gotoMarketplace(page)
    await expect(extensionCard(page, "PDF")).toBeVisible({ timeout: 20_000 })
    await expect(extensionCard(page, "Claxedo")).toBeVisible()
    await expect(extensionCard(page, "Filesystem")).toBeVisible()
  })

  test("MCP server-name conflict against an unowned entry surfaces a legible error and never overwrites — behavior 4", async ({ page }) => {
    const claudeJsonPath = path.join(scratchHome, ".claude.json")
    const unownedEntry = {
      mcpServers: {
        claxedo: { command: "/usr/bin/false", args: ["not-ours"] },
      },
    }
    await fs.mkdir(scratchHome, { recursive: true })
    await fs.writeFile(claudeJsonPath, `${JSON.stringify(unownedEntry, null, 2)}\n`)

    await gotoMarketplace(page)
    await installViaUi(page, "Claxedo")

    await expectToast(page, "Failed to install Claxedo")
    await expect(page.locator('[data-slot="toast-description"]', { hasText: /already exists/ })).toBeVisible({
      timeout: 15_000,
    })

    // The unowned entry survives byte-for-byte — never a silent overwrite.
    const afterClaudeJson = await readJsonFile(claudeJsonPath)
    expect(afterClaudeJson).toEqual(unownedEntry)

    // Supplementary (not the primary proof — see HARNESS NOTES): the
    // materialized record shows the conflicting component failed while the
    // package overall did not silently report success.
    const materialized = await readJsonFile(path.join(stateRoot(), "materialized.json"))
    const packages = materialized.packages as Record<string, { status: string; components: Array<{ runner: string; type: string; status: string; reason?: string }> }>
    const claxedoPkg = packages["claxedo-mcp"]
    expect(claxedoPkg?.status).not.toBe("applied")
    // `type: "mcp"` is load-bearing, not decoration: `claxedo-mcp` is NOT an
    // MCP-only package — it also ships `skills/claxedo-documents` and
    // `skills/<name>`, and `materializePackage` emits one component per
    // (target × discovered component) with skills FIRST
    // (`discovery.ts`'s `discoverAgentExtensionComponents` orders skills
    // before mcp). The claude runner therefore contributes THREE components
    // here — two applied skills, then the conflicting MCP — so a bare
    // `find((c) => c.runner === "claude")` resolves to the applied
    // `claxedo-documents` skill and reports "applied" for a conflict that
    // did correctly fail. Pin the component this behavior is actually about.
    const claudeComponent = claxedoPkg?.components.find((c) => c.runner === "claude" && c.type === "mcp")
    expect(claudeComponent?.status).toBe("failed")
    expect(claudeComponent?.reason).toMatch(/already exists/)

    // The card must revert to "Install", never show a false "Installed".
    await expect(extensionCard(page, "Claxedo").getByText("Installed", { exact: true })).toHaveCount(0)

    // Clean the poisoned file so the real successful-install test below
    // (which installs the SAME package id) starts from a clean target —
    // see the ordering comment on test.describe.configure above.
    await fs.rm(claudeJsonPath, { force: true })
  })

  test("installing a skill via the marketplace UI materializes state + the per-harness skill directory — behavior 2", async ({ page }) => {
    await gotoMarketplace(page)
    await installViaUi(page, "PDF")
    await expectToast(page, "PDF installed")
    await expectInstalledPill(page, "PDF")

    const installed = await readJsonFile(path.join(stateRoot(), "installed.json"))
    const installs = installed.installs as Array<{ id: string; scope: string; enabled: boolean; targets: string[] }>
    const pdfInstall = installs.find((i) => i.id === "anthropic-skill-pdf")
    expect(pdfInstall).toBeDefined()
    expect(pdfInstall?.scope).toBe("machine")
    expect(pdfInstall?.enabled).toBe(true)
    expect(pdfInstall?.targets).toEqual(["claude"])

    const lock = await readJsonFile(path.join(stateRoot(), "lock.json"))
    const lockPackages = lock.packages as Record<string, { resolved_sha: string; source: { owner?: string; repo?: string } }>
    expect(lockPackages["anthropic-skill-pdf"]?.resolved_sha).toMatch(/^[a-f0-9]{7,40}$/)
    expect(lockPackages["anthropic-skill-pdf"]?.source.owner).toBe("anthropics")
    expect(lockPackages["anthropic-skill-pdf"]?.source.repo).toBe("skills")

    const materialized = await readJsonFile(path.join(stateRoot(), "materialized.json"))
    const packages = materialized.packages as Record<string, { status: string; components: Array<{ runner: string; type: string; status: string; path?: string }> }>
    const pdfPkg = packages["anthropic-skill-pdf"]
    expect(pdfPkg?.status).toBe("applied")
    expect(pdfPkg?.components).toEqual([
      expect.objectContaining({ runner: "claude", type: "skill", status: "applied" }),
    ])

    // Real symlinked skill content on disk under scratch HOME.
    const skillDir = path.join(scratchHome, ".claude", "skills", "pdf")
    expect(await exists(skillDir)).toBe(true)
    const skillFile = path.join(skillDir, "SKILL.md")
    expect(await exists(skillFile)).toBe(true)
    const skillText = await fs.readFile(skillFile, "utf8")
    expect(skillText.toLowerCase()).toContain("pdf")

    // recommendedTargets is ["claude"] ONLY for this catalog entry (verified
    // against packages/claxedo-server-core/src/agent-config/extensions/catalog.ts) — the
    // other three harness skill directories the plan's spec-23 entry
    // anticipated for "a skill" in general are correctly NOT created for
    // THIS specific entry. Pin that explicitly rather than silently not
    // checking it.
    expect(await exists(path.join(scratchHome, ".codex", "skills", "pdf"))).toBe(false)
    expect(await exists(path.join(scratchHome, ".config", "opencode", "skills", "pdf"))).toBe(false)
    expect(await exists(path.join(scratchHome, ".cursor", "skills", "pdf"))).toBe(false)
  })

  test("installing claxedo-mcp via the marketplace UI merges into every harness target, preserves content, rewrites env, strips credentials — behavior 3", async ({ page }) => {
    // Pre-existing, unrelated content that must survive the merge.
    const cursorMcpPath = path.join(scratchHome, ".cursor", "mcp.json")
    await fs.mkdir(path.dirname(cursorMcpPath), { recursive: true })
    await fs.writeFile(cursorMcpPath, `${JSON.stringify({ mcpServers: { "hand-written": { command: "/bin/echo" } } }, null, 2)}\n`)

    // Pre-existing comment that a naive JSON.stringify rewrite would drop.
    const opencodeJsoncPath = path.join(scratchHome, ".config", "opencode", "opencode.jsonc")
    await fs.mkdir(path.dirname(opencodeJsoncPath), { recursive: true })
    await fs.writeFile(opencodeJsoncPath, "{\n  // kept: hand-written comment must survive the mcp merge\n}\n")

    await gotoMarketplace(page)
    await installViaUi(page, "Claxedo")
    await expectToast(page, "Claxedo installed")
    await expectInstalledPill(page, "Claxedo")

    const installed = await readJsonFile(path.join(stateRoot(), "installed.json"))
    const installs = installed.installs as Array<{ id: string; targets: string[] }>
    const mcpInstall = installs.find((i) => i.id === "claxedo-mcp")
    expect(mcpInstall?.targets.slice().sort()).toEqual(["claude", "codex", "cursor", "opencode"])

    const materialized = await readJsonFile(path.join(stateRoot(), "materialized.json"))
    const packages = materialized.packages as Record<string, { status: string }>
    expect(packages["claxedo-mcp"]?.status).toBe("applied")

    // .cursor/mcp.json: merged, hand-written sibling entry preserved.
    const cursorMcp = await readJsonFile(cursorMcpPath)
    const cursorServers = cursorMcp.mcpServers as Record<string, { command?: string; env?: Record<string, string> }>
    expect(cursorServers["hand-written"]).toEqual({ command: "/bin/echo" })
    expect(cursorServers.claxedo).toBeDefined()
    expect(cursorServers.claxedo?.env?.CLAXEDO_SERVER_URL).toBe(BACKEND_URL)
    for (const key of Object.keys(cursorServers.claxedo?.env ?? {})) {
      expect(key.startsWith("CLAXEDO_") && key.endsWith("_TOKEN")).toBe(false)
    }

    // .claude.json (machine-scope claude target): merged.
    const claudeJson = await readJsonFile(path.join(scratchHome, ".claude.json"))
    const claudeServers = claudeJson.mcpServers as Record<string, { type?: string; env?: Record<string, string> }>
    expect(claudeServers.claxedo?.type).toBe("stdio")
    expect(claudeServers.claxedo?.env?.CLAXEDO_SERVER_URL).toBe(BACKEND_URL)

    // .codex/config.toml: TOML section merged.
    const codexToml = await fs.readFile(path.join(scratchHome, ".codex", "config.toml"), "utf8")
    expect(codexToml).toMatch(/\[mcp_servers\.claxedo\]/)
    expect(codexToml).toContain(BACKEND_URL)

    // opencode.jsonc: jsonc-edit merge, comment preserved.
    const opencodeJsonc = await fs.readFile(opencodeJsoncPath, "utf8")
    expect(opencodeJsonc).toContain("// kept: hand-written comment must survive the mcp merge")
    expect(opencodeJsonc).toMatch(/"claxedo"/)
  })

  test("uninstalling a package via the marketplace UI removes materialized artifacts and state — behavior 5", async ({ page }) => {
    await gotoMarketplace(page)
    await expectInstalledPill(page, "PDF")

    const skillDir = path.join(scratchHome, ".claude", "skills", "pdf")
    expect(await exists(skillDir)).toBe(true)

    await uninstallViaUi(page, "PDF")
    await expectToast(page, "PDF uninstalled")

    const card = extensionCard(page, "PDF")
    await expect(card.getByRole("button", { name: "Install", exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(card.getByText("Installed", { exact: true })).toHaveCount(0)

    const installed = await readJsonFile(path.join(stateRoot(), "installed.json"))
    const installs = installed.installs as Array<{ id: string }>
    expect(installs.some((i) => i.id === "anthropic-skill-pdf")).toBe(false)

    const lock = await readJsonFile(path.join(stateRoot(), "lock.json"))
    const lockPackages = lock.packages as Record<string, unknown>
    expect(lockPackages["anthropic-skill-pdf"]).toBeUndefined()

    const materialized = await readJsonFile(path.join(stateRoot(), "materialized.json"))
    const packages = materialized.packages as Record<string, unknown>
    expect(packages["anthropic-skill-pdf"]).toBeUndefined()

    // The symlinked skill directory itself is gone from disk.
    expect(await exists(skillDir)).toBe(false)
  })

  test("Detect existing scans the active project's real filesystem for pre-existing config — behavior 8 (scan half)", async ({ page }) => {
    const dir = await makeWorkspace("scan")
    await fs.writeFile(
      path.join(dir, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { "pre-existing": { command: "/bin/true" } } }, null, 2)}\n`,
    )

    await page.addInitScript((d: string) => {
      localStorage.clear()
      ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
        serverUrl: window.location.origin,
        activeDirectory: d,
      }
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [],
          projects: { local: [{ worktree: d, expanded: true }] },
          lastProject: {},
          workspaceServer: {},
          closedProjects: {},
        }),
      )
    }, dir)

    // Establish the active-directory context (client-side SDK state) before
    // navigating to the directory-less /marketplace route — same technique
    // core-first-prompt-local.spec.ts's seedOneProject() uses.
    await page.goto(`/${slug(dir)}/session`)
    await page.waitForLoadState("domcontentloaded")
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

    await page.goto("/marketplace")
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

    await page.getByRole("button", { name: /Detect existing/ }).click()
    await expect(page.getByText(/Detected \d+ existing item/)).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText(".mcp.json", { exact: false })).toBeVisible()
    await expect(page.getByText("MCP config")).toBeVisible()
  })

  // [UI LANDED, awaiting live run — see SPEC block, BEHAVIORS #6] The
  // disable/enable toggle now exists: hovering the "Installed" pill's
  // group/install wrapper reveals a "Disable" control (and, once disabled, an
  // "Enable" control), wired to POST /extensions/:id/{disable,enable}. The
  // pure request/state logic (`enablementToggle`, `isRecordEnabled`,
  // `installedRecordsFromJson`'s enabled parse) is unit-tested in
  // `install-flow.test.ts`. This body drives the real UI + real materializer
  // and is ready to un-fixme on an idle machine with CLAXEDO_E2E_LIVE=1 (it
  // could not be executed in this authoring session's contended env — see
  // HARNESS NOTES).
  test.fixme(
    "disable a package via the marketplace UI removes artifacts but retains state, enable restores them — behavior 6",
    async ({ page }) => {
      await gotoMarketplace(page)
      await installViaUi(page, "PDF")
      await expectToast(page, "PDF installed")
      await expectInstalledPill(page, "PDF")

      const skillDir = path.join(scratchHome, ".claude", "skills", "pdf")
      expect(await exists(skillDir)).toBe(true)

      // Disable — hover the installed pill's own wrapper (group/install) to
      // reveal the "Disable" control (exact:true so it never resolves the
      // hidden "Uninstall"/"Enable" siblings).
      const card = extensionCard(page, "PDF")
      const installGroup = card.locator('[class*="group/install"]')
      await installGroup.hover()
      await installGroup.getByRole("button", { name: "Disable", exact: true }).click()
      await expectToast(page, "PDF disabled")

      // Desired state retained (enabled:false), materialized status flipped to
      // "disabled", artifact removed from disk.
      const installedAfterDisable = await readJsonFile(path.join(stateRoot(), "installed.json"))
      const disabledInstall = (installedAfterDisable.installs as Array<{ id: string; enabled: boolean }>).find((i) => i.id === "anthropic-skill-pdf")
      expect(disabledInstall?.enabled).toBe(false)
      const materializedDisabled = await readJsonFile(path.join(stateRoot(), "materialized.json"))
      expect((materializedDisabled.packages as Record<string, { status: string }>)["anthropic-skill-pdf"]?.status).toBe("disabled")
      expect(await exists(skillDir)).toBe(false)

      // Enable — restores the artifact and materialized status.
      await installGroup.hover()
      await installGroup.getByRole("button", { name: "Enable", exact: true }).click()
      await expectToast(page, "PDF enabled")
      const installedAfterEnable = await readJsonFile(path.join(stateRoot(), "installed.json"))
      const enabledInstall = (installedAfterEnable.installs as Array<{ id: string; enabled: boolean }>).find((i) => i.id === "anthropic-skill-pdf")
      expect(enabledInstall?.enabled).toBe(true)
      const materializedEnabled = await readJsonFile(path.join(stateRoot(), "materialized.json"))
      expect((materializedEnabled.packages as Record<string, { status: string }>)["anthropic-skill-pdf"]?.status).toBe("applied")
      expect(await exists(skillDir)).toBe(true)

      // Clean the shared state for any later test in this serial file.
      await uninstallViaUi(page, "PDF")
      await expectToast(page, "PDF uninstalled")
    },
  )

  // [UI PATH LANDED, blocked on CATALOG — see SPEC block, BEHAVIORS #7] The
  // marketplace card/install path is kind-agnostic: ExtensionCard renders a
  // `kind: "plugin"` entry (KIND_LABEL.plugin -> "Plugin") and `install()`
  // POSTs source/scope/targets identically for every kind, so the moment the
  // curated catalog (`packages/claxedo-server/src/hosts/agent-extensions/
  // catalog.ts`'s ENTRIES) gains a `kind: "plugin"` entry it installs through
  // the exact same surface — no further UI work is required. Proven at the
  // unit layer by install-flow.test.ts's "parses a kind:'plugin' entry and
  // labels it 'Plugin'". This body STAYS fixme until a real plugin catalog
  // entry exists (per the task's "do not invent catalog entries" rule) AND a
  // live run is available; there is genuinely nothing installable of
  // kind:"plugin" to drive end-to-end today.
  test.fixme(
    "install a Cursor plugin via the marketplace UI — behavior 7",
    async () => {},
  )

  // [UI LANDED, awaiting live run — see SPEC block, BEHAVIORS #8] Each
  // DiscoveredSection row now hover-reveals per-item "Adopt" and "Ignore"
  // controls (group/discovered), wired to POST /extensions/{adopt,ignore}
  // with { directory, path }; the top-level "Dismiss" (local clear) stays.
  // Pure request/state logic (`discoveredStateForAction`,
  // `discoveredStateFromResponse`, `applyDiscoveredState`) is unit-tested in
  // install-flow.test.ts. This body drives the real UI + real
  // discovery.json persistence and is ready to un-fixme on an idle machine
  // with CLAXEDO_E2E_LIVE=1 (could not run in this contended authoring env —
  // see HARNESS NOTES).
  test.fixme(
    "adopt a discovered item via the marketplace UI — behavior 8 (adopt half)",
    async ({ page }) => {
      const dir = await makeWorkspace("adopt")
      // "mcp.json" (no leading dot) is the real scan candidate path
      // (`scan.ts`'s `candidates`) — the value the UI shows and that the
      // adopt request must round-trip back to the server unchanged.
      await fs.writeFile(
        path.join(dir, "mcp.json"),
        `${JSON.stringify({ mcpServers: { "pre-existing": { command: "/bin/true" } } }, null, 2)}\n`,
      )

      await page.addInitScript((d: string) => {
        localStorage.clear()
        ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
          serverUrl: window.location.origin,
          activeDirectory: d,
        }
        localStorage.setItem(
          "opencode.global.dat:server",
          JSON.stringify({
            list: [],
            projects: { local: [{ worktree: d, expanded: true }] },
            lastProject: {},
            workspaceServer: {},
            closedProjects: {},
          }),
        )
      }, dir)

      await page.goto(`/${slug(dir)}/session`)
      await page.waitForLoadState("domcontentloaded")
      await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

      await page.goto("/marketplace")
      await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

      await page.getByRole("button", { name: /Detect existing/ }).click()
      await expect(page.getByText(/Detected \d+ existing item/)).toBeVisible({ timeout: 20_000 })

      // The discovered row for mcp.json — hover reveals the Adopt control.
      const row = page.locator("li.group\\/discovered").filter({ has: page.getByText("mcp.json", { exact: false }) })
      await expect(row).toBeVisible({ timeout: 10_000 })
      await row.hover()
      await row.getByRole("button", { name: "Adopt", exact: true }).click()
      await expectToast(page, "Adopted mcp.json")

      // Server persisted the adopted state under the project's
      // .agent-extensions/discovery.json (real POST /extensions/adopt round
      // trip, not a local-only clear like Dismiss).
      const discovery = await readJsonFile(path.join(dir, ".agent-extensions", "discovery.json"))
      const records = discovery.records as Array<{ path: string; state: string }>
      expect(records.some((r) => r.path === "mcp.json" && r.state === "adopted")).toBe(true)

      // Row reflects the new adopted state inline.
      await row.hover()
      await expect(row.getByText("Adopted", { exact: true })).toBeVisible({ timeout: 10_000 })
    },
  )

  // Cloud half — gated on the explicit opt-in env var per this suite's Tier
  // L contract (not merely on the docker binary/daemon being present — see
  // SPEC block HARNESS NOTES for why, and for this run's actual gating
  // outcome and the honesty caveat about this body never having executed).
  test(
    "workspace-scope install replays into a Docker sandbox via applyRuntimeAgentExtensions — behavior 9 (cloud half)",
    async ({ page }) => {
      test.skip(
        !DOCKER_SANDBOX,
        "Cloud half gated on CLAXEDO_ENABLE_DOCKER_SANDBOX=1 (docker sandbox provisioning also needs a built " +
          "sandbox image + control-plane authority wiring this spec does not stand up itself) — unset in this " +
          "environment, so this is a loud, named skip, not a silent no-op. See e2e/INVARIANTS.md's Tier L gating " +
          "contract and this file's SPEC block HARNESS NOTES.",
      )
      // Not implemented pending CLAXEDO_ENABLE_DOCKER_SANDBOX=1 availability
      // in a runner that also has a built sandbox image + authority wiring.
      // See SPEC block BEHAVIORS #9 and HARNESS NOTES for the exact real
      // contract this must prove once implemented: create a Docker sandbox
      // workspace, install `claxedo-mcp` at workspace scope through the
      // marketplace UI (scope=workspace), poll
      // `.workspace-runtime/runtime-config/accepted-snapshot.json` for the
      // install id and `apply-status.json` for `state: "applied"`, then
      // `docker exec` into the sandbox container to assert the materialized
      // files exist inside its filesystem.
      void page
      throw new Error("cloud half not implemented — see this test's skip reason and the SPEC block HARNESS NOTES")
    },
  )
})

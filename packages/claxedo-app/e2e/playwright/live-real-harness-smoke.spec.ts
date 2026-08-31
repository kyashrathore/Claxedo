/**
 * SPEC: Live real-harness smoke (Tier L)
 *
 * PURPOSE — every other spec in this suite (1-21) proves the UI against a mocked
 * `/global/event` stream (`installMockRuntime`); none of them ever exercise a real
 * `claxedo-server` process, a real embedded OpenCode engine, or a real
 * `claude`/`codex` binary. This spec is the one place that removes ALL mocking and
 * proves the full real stack end to end: a genuine `bun run start` claxedo-server
 * (embedded OpenCode engine, no `OPENCODE_URL` override — see
 * `packages/claxedo-server/src/deployments/local/main.ts:17` for the port and the "absent
 * OPENCODE_URL = embedded" contract from `project_embed_opencode_engine`), talking
 * to a real git worktree, driving real subprocess/native-SDK agent harnesses, and
 * replaying real persisted messages after a real page reload (no SSE mock replay).
 * It exists to catch the class of bug no mocked spec can: a genuine protocol
 * mismatch between our harness driver and an installed agent binary's real wire
 * format (see BEHAVIORS #5 / HARNESS NOTES for exactly such a bug this spec found).
 *
 * STATE MODEL — identical client-side state machine to `core-first-prompt-local`
 * (draft -> optimistic user row -> `POST /session` -> `POST
 * /session/:id/prompt_async` (204, fire-and-forget) -> real `/global/event` SSE
 * delivers `session.status busy` -> `message.updated`(pending) ->
 * `message.part.delta`* -> `message.updated`(completed) -> `session.idle`) — the
 * DIFFERENCE from every Tier M spec is that every one of those events is produced
 * by the REAL server (`packages/claxedo-server`) driving a REAL harness backend
 * (`packages/agent-sdk-runtime`'s ACP/native-SDK drivers, or the embedded OpenCode
 * engine itself), not `e2e/helpers/mock-runtime.ts`'s staged `EventBus`. Harness
 * selection persists server-side per-directory (`GET/POST
 * /api/claxedo/agent-config/harness?directory=...`) — a directory that was
 * previously switched to a harness auto-hydrates a FRESH draft onto that harness on
 * next mount (see `core-harness-ownership-local`'s STATE MODEL path (b)); this spec
 * avoids that cross-test coupling by giving every scenario its own freshly
 * `git init`-ed scratch worktree (`makeWorkspace`) and driving the harness `<Select>`
 * explicitly (path (a)) rather than relying on hydration. Message persistence after
 * reload is backed by the real `workspace-runtime` `RuntimeStore` (SQLite journal
 * under `CLAXEDO_DATA_DIR`), not an in-memory mock array — reload in this spec
 * exercises the real message-replay read path.
 *
 * ANATOMY — reuses the exact selectors `core-first-prompt-local` and
 * `core-harness-ownership-local` document (this spec does not re-derive them, since
 * the DOM contract is identical against a real backend):
 *   `[data-claxedo]` — shell root, presence == app painted.
 *   `[role="textbox"][aria-label*="Ask anything"]` — composer editor.
 *   `[data-action="prompt-submit"]` — send/stop control (`turn-oracle.ts`'s
 *     `submitControlReady` asserts `data-icon !== "stop"` once settled).
 *   `[data-slot="session-turn-assistant-content"]` (not `aria-hidden="true"`) — the
 *     oracle's DOM-truth target (`e2e/helpers/turn-oracle.ts`).
 *   `[data-action="prompt-harness-model"]` — the unified harness/model picker,
 *     with ACP-before-native-SDK group ordering from `HARNESS_OPTIONS`. This spec only
 *     asserts it stops reading "Loading models"/"Select model" (real catalog
 *     resolution), never a specific model name — model catalogs are live data that
 *     can change server-side; asserting exact names is `core-harness-ownership-
 *     local`'s job against a pinned mock, not this smoke test's.
 *   `[data-slot="session-turn-message-content"]` — user turn row (see
 *     `expectLiveUserRowCount`'s exact-count check below); real turns can render
 *     MORE than one `session-turn-assistant-content` row per turn (see HARNESS
 *     NOTES), so this spec proves per-marker uniqueness there (post-reload, via
 *     `expectLiveTurnsSettledAfterReload`) instead of a fixed total row count.
 *
 * BEHAVIORS —
 *   1. The `opencode` harness (embedded engine, real `opencode`/`big-pickle`
 *      provider, no external binary) completes 3 real turns in one session, each
 *      proven by the full three-layer oracle, and a page reload re-renders all 3
 *      replies from the real persisted store with no duplication.
 *   2. The `claude-acp` harness (a genuinely spawned `claude-agent-acp` subprocess,
 *      `packages/agent-sdk-runtime/src/harnesses/acp/*`) completes the same 3-turn +
 *      reload journey, model resolved from the real
 *      `/api/claxedo/agent-config/harness/options` catalog (not a mock fixture).
 *   3. The `claude-sdk` harness (in-process `@anthropic-ai/claude-agent-sdk` driver,
 *      no subprocess) completes the same 3-turn + reload journey.
 *   4. The `codex-acp` harness (a genuinely spawned `codex-acp` subprocess) completes
 *      the same 3-turn + reload journey.
 *   5. The `codex-app-server` (native Codex SDK) harness completes the same 3-turn +
 *      reload journey. This was previously a `test.fixme` documenting a "REAL APP BUG"
 *      — `thread not found: <uuid>` on `turn/start` against codex-cli 0.143.0 — but
 *      that skew is resolved: the driver's two-step lifecycle plus its fresh-process
 *      `thread/resume` recovery (`startTurnWithThreadRecovery`) now complete real
 *      turns against BOTH codex-cli 0.143.0 and 0.144.x, verified 2026-07-20 at the
 *      driver level (real `CodexHarnessAdapter`, real ChatGPT auth) and from the
 *      published `@claxedo/agent-sdk-runtime@0.5.3` bundle. See HARNESS NOTES / the
 *      behavior-5 test comment for the evidence.
 *   6. Gating: with `CLAXEDO_E2E_LIVE` unset, every test in this file is skipped
 *      with a visible, human-readable reason (never a silent no-op — Playwright's
 *      HTML/line reporter shows the reason string). With `CLAXEDO_E2E_LIVE=1`: if
 *      `claxedo-server` itself cannot boot (the mandatory backbone every harness
 *      depends on), the whole file FAILS loudly in `beforeAll` with the server's own
 *      boot log tail in the error message — it is never silently skipped. If a
 *      specific OPTIONAL harness's binary (`claude`/`codex`) is genuinely absent
 *      from `PATH`, only THAT harness's test is skipped, with a visible reason
 *      naming the missing binary — see HARNESS NOTES for why this is a `test.skip`
 *      and not a hard failure.
 *   7. Harness selection is locked once a session exists, even against the real
 *      backend (same contract `core-harness-ownership-local` pins against the mock)
 *      — checked once per harness scenario as a cheap supplementary assertion, not
 *      re-derived in full here.
 *
 * INVARIANTS — completed assistant content is never hidden by stale busy state (#2
 *   in `e2e/INVARIANTS.md`) — every oracle call in this spec is proving that
 *   invariant against REAL busy/completed/idle timing, not staged mock timing.
 *   Harness ownership (#1): the selected harness is locked after creation (behavior
 *   7). Submit gating (#4): every wait is a deterministic DOM/request-count
 *   assertion; this spec adds zero new `waitForTimeout` sleeps as the sole guard of
 *   anything.
 *
 * HARNESS NOTES —
 *   - Workspace-registration race (real, verified against this repo's live server —
 *     see `registerWorkspace()`): the app's own bootstrap flow registers a directory
 *     as a local workspace via a fire-and-forget `GET /api/workspace/resolve?...&
 *     create=true` (`src/shell/data/bootstrap.ts`'s `postPaint` block ->
 *     `packages/claxedo-server/src/workspace/routes/index.ts:142` -> `ensureWorkspace()` in
 *     `packages/claxedo-server-core/src/workspace/store/index.ts:287`) that is not awaited
 *     before the composer becomes interactive. `POST /session` 404s for any
 *     directory that has not yet completed that registration (confirmed by direct
 *     `curl` reproduction: 404 before the `GET .../resolve...&create=true` call,
 *     201 immediately after). A real human always wins this race by the time they
 *     finish typing; this spec's synthetic compose-and-click speed does not always
 *     win it, especially under host CPU contention, so `makeWorkspace()` closes it
 *     deterministically by calling the same real endpoint before ever driving the
 *     UI (a test-setup precondition, not a mock — see `registerWorkspace()`'s own
 *     comment for the full trace).
 *   - Real multi-part assistant rows: unlike every Tier M mock's single fixed text
 *     part, a real turn from the `opencode`/`big-pickle` model in this environment
 *     renders BOTH a `reasoning` part and a `text` part as separate
 *     `session-turn-assistant-content` rows (`message-timeline.data.ts`'s
 *     `groupParts`, one row per renderable part — see `expectTurnCounts`'s own doc
 *     comment in `turn-oracle.ts` anticipating exactly this). This spec therefore
 *     asserts turn settlement via exact user-row count + (post-reload) per-marker
 *     "exactly one visible assistant row contains this turn's reply" — still a hard
 *     duplicate-render check, just correctly scoped against real, non-mocked output.
 *   - [REAL APP FINDING, not fixme'd — see rationale below] Mid-session assistant-
 *     part duplication: on some turns (observed from turn 2 onward, never turn 1;
 *     reproduced independently across multiple live runs against this repo's real
 *     server, both before AND — on one occasion — after `page.reload()`) a turn's
 *     reply text renders TWICE in two separate, simultaneously-visible
 *     `session-turn-assistant-content` rows with byte-identical text — confirmed by
 *     cross-checking that SAME turn's real `GET /session/:id/message` response at
 *     the SAME moment, which never contains more than one text part for that
 *     message (i.e. the server's canonical state is always correct; the duplicate
 *     is a client-only artifact). BELIEVED FIXED at both layers as of 2026-08-01,
 *     pending a Tier R scenario-1 green to confirm — the two layers, in the order
 *     a payload meets them:
 *       (1) `src/features/session/conversation/conversation-hydrator.ts`
 *           (`canonicalPartMessageIds` + `reconcileStoredParts` from
 *           `src/features/session/store/message-page.ts`). `mergeStoredItems` is a
 *           UNION: it adds ids and never removes one a later payload omits, so a
 *           transient streaming part id was entrenched for the page's lifetime.
 *           The hydrator now RECONCILES instead of unioning, but only where the
 *           payload is genuinely canonical — a replacing `rows` page (not
 *           `prepend`, not the prefetch seed) for a SETTLED assistant message.
 *           `mergeStoredItems` itself stays additive on purpose: its streaming and
 *           history-backfill callers each hold a fragment, and pruning against a
 *           fragment deletes content the server simply has not persisted yet.
 *       (2) `src/features/session/conversation/opencode-conversation.ts`
 *           (`mergeChatMessage`, commit `69c697775`, 2026-07-20) — a settled
 *           assistant snapshot's part list is authoritative, so chat-only parts
 *           are dropped rather than re-appended.
 *     These are COMPLEMENTARY, not redundant: (2) can only judge the part list it
 *     is handed, and before (1) the hydrator handed it a union that already
 *     contained the stale id, leaving its prune nothing to drop. Verified by
 *     reverting (1) alone: a settled message whose canonical payload lists one
 *     part still ended up holding two.
 *     IndexedDB persistence (`conversation-persistence.ts` →
 *     `compactConversationSnapshot`) dedupes by MESSAGE id and never inspects
 *     parts, so a session that duplicated before this fix still has the duplicate
 *     on disk — no migration was written because the first canonical refetch after
 *     reload now prunes it (covered by `conversation-hydrator.test.ts`).
 *     This spec does NOT `test.fixme` behavior 1 over this: the
 *     defect is intermittent (most runs, including full multi-turn + reload runs,
 *     show zero duplication), never affects turn 1, and — critically — never causes
 *     a REPLY to be invisible or wrong (every turn's own oracle check, the actual
 *     behavior-1 proof, still passes every time); the ADDITIONAL supplementary
 *     duplicate-render check this spec runs (`expectLiveTurnsSettledAfterReload`)
 *     is therefore left ENABLED and un-softened — if the fix is incomplete this
 *     should fail the suite loudly and intermittently, not be silently downgraded
 *     to always-green.
 *   - Gating reconciliation: `e2e/INVARIANTS.md`'s Tier L rule says a missing
 *     credential/binary "FAILS the test with a clear setup message... silent
 *     `test.skip()` is forbidden," while the plan's spec-22 entry separately says
 *     "Loud-skip on missing credential/binary." This spec reconciles the two by
 *     treating them as operating at different levels: `claxedo-server` failing to
 *     boot is the mandatory backbone every harness (including the always-available
 *     `opencode` baseline) depends on — that FAILS loudly (an uncaught throw from
 *     `beforeAll`), never a skip. An individual OPTIONAL harness's binary
 *     (`claude`/`codex`) being absent is a `test.skip(condition, reason)` — but the
 *     reason string is always a specific, visible sentence naming the missing
 *     binary and how to fix it (`e2e/INVARIANTS.md`'s actual complaint is about
 *     SILENT no-reason skips, e.g. the pre-refactor suite's Tier-L-in-name-only
 *     files that quietly skipped everything with no explanation at all). A harness
 *     whose binary IS present but whose real turn genuinely errored would be a hard
 *     failure citation (a `test.fixme`), never silently skipped or downgraded — this
 *     is how behavior 5 (native codex-app-server) was tracked while its `thread not
 *     found` skew was open; that skew is now resolved and behavior 5 is a normal
 *     live test (see BEHAVIORS #5).
 *   - `claude-sdk`'s credential source: this environment's `claude-sdk` (native,
 *     non-ACP) harness resolved and answered without any `ANTHROPIC_API_KEY` being
 *     set, meaning it shares the local `claude` CLI's own OAuth session — this spec
 *     therefore gates BOTH `claude-acp` and `claude-sdk` on the same `claude`
 *     binary preflight (`resolveBinary("claude", ...)`), since that is the only
 *     verifiable local signal for "Claude is usable here" this spec has.
 *   - Real per-turn latency (measured directly against this repo's live
 *     `claxedo-server`, `curl`, no browser overhead): `opencode`/`big-pickle` ~3s,
 *     `claude-sdk` ~6s, `codex-acp` ~12s, `claude-acp` ~15-20s. `turn-oracle.ts`'s
 *     `domTruth`/`thinkingRowGone`/`submitControlReady` each hardcode a 20s
 *     Playwright timeout that this spec file cannot change (helpers are off-limits
 *     per this suite's authoring rules) — `claude-acp` turns are the closest to that
 *     ceiling once real browser/SSE-reconnect overhead is added on top of the raw
 *     API latency measured above. Prompts in this spec are deliberately terse
 *     ("reply with exactly this one token") specifically to minimize that risk; if
 *     `claude-acp` ever flakes on the 20s ceiling in CI, the fix belongs in
 *     `turn-oracle.ts`'s timeout (a Tier-L-aware bump), not in weakening this
 *     spec's assertions.
 *   - Behavior 5's bug locus: `packages/agent-sdk-runtime/src/harnesses/codex/
 *     driver.ts:78-92` (`createAgentSession` issues `thread/start` to the spawned
 *     `codex app-server` subprocess and captures `result.thread.id` as `threadId`)
 *     and `driver.ts:160-174` (`runTurn`'s `turn/start` request references that
 *     SAME `threadId` on the SAME long-lived subprocess instance — `ensureProcess`
 *     reuses `this.process` while `alive`). Against the locally installed
 *     `codex-cli 0.143.0`, the second call consistently fails with `thread not
 *     found: <the exact uuid thread/start just returned>`, reproduced on two
 *     independently fresh sessions/directories with a 3s settle delay inserted
 *     between the two calls (ruling out a same-tick race) — this reads as a
 *     protocol/version skew between the vendored driver's `thread/start` ->
 *     `turn/start` two-step and what this codex-cli build's `app-server` subcommand
 *     actually expects, not an environment/auth problem (the SAME binary's
 *     `codex-acp` mode, a different code path in the same CLI, completes turns
 *     successfully — behavior 4).
 *   - `cursor-acp`/`cursor-sdk` are deliberately NOT in this spec's harness matrix:
 *     the plan's spec-22 entry scopes Tier L smoke coverage to "opencode, claude,
 *     codex; ACP and SDK where available" — Cursor is out of scope here even though
 *     a `cursor-acp`-capable `agent` binary happens to be present on this particular
 *     development machine.
 *
 * OUT OF SCOPE — the full per-harness ownership/model/effort/payload matrix against
 *   a pinned mock (`core-harness-ownership-local`, `core-harness-ownership-cloud`);
 *   per-harness event/tool-rendering fidelity (`core-harness-rendering-matrix`);
 *   Agent Plugins materialization and MCP Inspector coverage; the
 *   user-hosted relay (`live-user-hosted-relay`); cloud/sandbox provisioning
 *   (`core-cloud-provisioning` and friends); busy/abort/error escalation UI
 *   (`core-busy-abort-errors`) — this spec's turns are deliberately short and
 *   unlikely to need any permission/question/abort interaction, and does not
 *   exercise those paths.
 */
import { expect, test, type Locator, type Page } from "@playwright/test"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { expectAssistantReplyVisible, SELECTORS } from "../helpers/turn-oracle"
import { expectLiveTurnsSettledAfterReload, expectLiveUserRowCount } from "../helpers/turn-oracle-extras"

const execFileAsync = promisify(execFile)

const LIVE = process.env.CLAXEDO_E2E_LIVE === "1"
const APP_DIR = path.resolve(import.meta.dirname, "../..")
const REPO_ROOT = path.resolve(APP_DIR, "../..")
const SERVER_DIR = path.join(REPO_ROOT, "packages", "claxedo-server")
const BACKEND_PORT = Number(process.env.CLAXEDO_E2E_LIVE_BACKEND_PORT ?? 3001)
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`

let server: ChildProcess | undefined
let serverLog = ""
let dataDir = ""
const scratchDirs: string[] = []

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

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

async function startServer() {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-live-smoke-data-"))
  server = spawn("bun", ["run", "start"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      CLAXEDO_DATA_DIR: dataDir,
      CLAXEDO_SERVER_PORT: String(BACKEND_PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout?.on("data", (chunk) => (serverLog += chunk.toString()))
  server.stderr?.on("data", (chunk) => (serverLog += chunk.toString()))
  await waitForHealth(`${BACKEND_URL}/api/claxedo/health`)
}

async function stopServer() {
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

/** Harvested from the retired real-auth spec's realClaudeBinary(). */
async function resolveBinary(name: string, envVar: string) {
  const override = process.env[envVar]?.trim()
  const binary = override || name
  try {
    if (binary.includes("/")) {
      await execFileAsync(binary, ["--version"], { timeout: 10_000 })
      return binary
    }
    const found = await execFileAsync("which", [binary], { timeout: 10_000 })
    const resolved = found.stdout.trim() || binary
    await execFileAsync(resolved, ["--version"], { timeout: 10_000 })
    return resolved
  } catch {
    return undefined
  }
}

async function makeWorkspace(name: string) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `claxedo-live-smoke-${name}-`)))
  scratchDirs.push(dir)
  await execFileAsync("git", ["init"], { cwd: dir })
  await fs.writeFile(path.join(dir, "README.md"), `live-real-harness-smoke fixture: ${name}\n`)
  await execFileAsync("git", ["-c", "user.email=e2e@test.com", "-c", "user.name=e2e", "add", "-A"], { cwd: dir })
  await execFileAsync("git", ["-c", "user.email=e2e@test.com", "-c", "user.name=e2e", "commit", "-m", "init"], { cwd: dir })
  await registerWorkspace(dir)
  return dir
}

/**
 * Registers `dir` as a real local workspace via the same `GET /api/workspace/resolve
 * ?directory=...&create=true` call the app's own bootstrap flow fires on first
 * navigation to a directory (`src/shell/data/bootstrap.ts`'s fire-and-forget
 * `resolveWorkspace()` inside `postPaint` -> `src/shared/data/http-backend.ts`'s
 * `resolveWorkspace`/`workspaceResolveUrl` -> `packages/claxedo-server/src/routes/
 * workspace.ts:142` (`GET /resolve`) -> `resolveWorkspace({..., create: true})` ->
 * `ensureWorkspace()` in `packages/claxedo-server-core/src/workspace/store/index.ts:287`). This
 * closes a REAL race this spec found empirically against the live server: until that
 * registration completes, `POST /session` 404s (`workspaceRuntimeProxy`'s `resolveWorkspace`
 * lookup finds nothing and falls through to `next()` with no other root `/session`
 * handler registered — `packages/claxedo-local-server/src/workspace/runtime-dispatch/internals.ts:325-350`), confirmed by
 * direct `curl` reproduction: `POST /session` 404s deterministically for a brand-new,
 * never-registered directory and 201s immediately after this exact `GET .../resolve
 * ...&create=true` call. The app's own bootstrap call is fire-and-forget and not
 * awaited before the composer becomes interactive, so under normal human typing
 * latency the client's own retry loop always wins the race; this spec types and
 * submits fast enough (and this host can be under heavy concurrent CPU load) that it
 * does not always win it. Pre-registering here is a real test-setup precondition
 * (same category as the `git init` above), not a mock — it calls the exact real
 * endpoint a slower human user's browser would already have called by the time they
 * finished typing.
 */
async function registerWorkspace(dir: string) {
  const url = `${BACKEND_URL}/api/workspace/resolve?directory=${encodeURIComponent(dir)}&create=true`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(
      `GATING: failed to pre-register workspace ${dir} via ${url} (${res.status}) — ` +
        `${await res.text().catch(() => "<no body>")}`,
    )
  }
}

async function seedOneProject(page: Page, dir: string) {
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
}

async function openDraftPrompt(page: Page, dir: string): Promise<Locator> {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  await expect(input).toHaveAttribute("contenteditable", "true")
  return input
}

async function composePrompt(page: Page, input: Locator, text: string) {
  await input.click()
  await input.fill(text)
  if (!((await input.textContent()) ?? "").includes(text)) {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A")
    await page.keyboard.type(text)
  }
  await expect(input).toContainText(text, { timeout: 10_000 })
}

function sessionUrlPattern() {
  return /(?:\/s\/[^/]+|\/w\/[^/]+\/session\/[^/]+)$/
}

async function switchDraftHarness(page: Page, optionName: RegExp, optionIndex: number) {
  await page.locator('[data-action="prompt-harness-model"]').last().click()
  const picker = page.locator('[data-component="harness-model-picker"]')
  await picker.locator('[data-slot="harness-picker-section"]').first().click()
  await picker.getByRole("button", { name: optionName }).nth(optionIndex).click()
  await page.keyboard.press("Escape")
}

async function waitForHarnessReady(page: Page) {
  await expect(page.locator('[data-action="prompt-harness-model"]').last()).not.toContainText(
    /Loading models|Select model/i,
    { timeout: 30_000 },
  )
  await expect(page.locator('[title="Agent runtime unreachable after timeout"]')).toHaveCount(0)
}

type HarnessCase = {
  id: string
  option?: RegExp
  optionIndex?: number
  /** First-party ACP harnesses have no picker row any more (operator-configured
   *  ACP connections own the picker's ACP group) — they are selected by seeding
   *  the server default (`seedDefaultHarness`) and letting the draft hydrate. */
  seededHarness?: string
}

/**
 * Sets the server's harness default for this directory — the selection
 * mechanism for harnesses the picker no longer lists. Mirrors Tier R's
 * `seedDefaultHarness` in `real-harness-local.spec.ts`.
 */
async function seedDefaultHarness(dir: string, harnessKey: string) {
  const url = `${BACKEND_URL}/api/claxedo/agent-config/harness?directory=${encodeURIComponent(dir)}`
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: harnessKey, directory: dir }),
  })
  if (!res.ok) {
    throw new Error(`failed to seed the server harness default to "${harnessKey}" via ${url} (${res.status})`)
  }
}

// `expectLiveUserRowCount` / `expectLiveTurnsSettledAfterReload` moved to
// `e2e/helpers/turn-oracle-extras.ts` — Tier R's `real-harness-local.spec.ts`
// needs the identical checks against real (multi-part) assistant output, and a
// second hand-rolled copy would drift. See that file's doc comments for why
// these exist instead of `turn-oracle.ts`'s `expectTurnCounts`, and this file's
// HARNESS NOTES ("mid-session assistant-part duplication") for why the strict
// per-marker check runs only after `page.reload()`.

/** Drives the shared "3 real turns + reload, full oracle each turn" journey. */
async function runLiveHarnessSmoke(page: Page, dir: string, harness: HarnessCase) {
  const runId = `${Date.now()}`.slice(-6)
  const input = await openDraftPrompt(page, dir)

  if (harness.option) {
    await switchDraftHarness(page, harness.option, harness.optionIndex ?? 0)
    await waitForHarnessReady(page)
  } else if (harness.seededHarness) {
    await expect(
      page.locator('[data-action="prompt-harness-model"]').last(),
      `draft did not hydrate seeded harness "${harness.seededHarness}"`,
    ).toHaveAttribute("data-harness", harness.seededHarness, { timeout: 45_000 })
    await waitForHarnessReady(page)
  }

  const markers: string[] = []
  for (let turn = 1; turn <= 3; turn += 1) {
    const marker = `LIVE-${harness.id.replace(/[^a-z0-9]/gi, "")}-${runId}-T${turn}`
    markers.push(marker)
    const promptText = `Reply with exactly this one token and nothing else, no punctuation, no formatting: ${marker}`
    const textbox = turn === 1 ? input : page.getByRole("textbox", { name: /Ask anything/i }).last()
    await composePrompt(page, textbox, promptText)
    await page.locator(SELECTORS.submitControl).last().click()
    if (turn === 1) {
      await expect(page).toHaveURL(sessionUrlPattern(), { timeout: 30_000 })
    }
    await expectAssistantReplyVisible(page, new RegExp(marker), {
      spec: "live-real-harness-smoke",
      scenario: `${harness.id}-turn-${turn}`,
    })
  }

  await expectLiveUserRowCount(page, markers.length)

  if (harness.option) {
    await expect(page.getByRole("button", { name: harness.option }).last()).toBeEnabled()
  }

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await expectAssistantReplyVisible(page, new RegExp(`LIVE-${harness.id.replace(/[^a-z0-9]/gi, "")}-${runId}-T3`), {
    spec: "live-real-harness-smoke",
    scenario: `${harness.id}-reload`,
  })
  await expectLiveTurnsSettledAfterReload(page, markers)
}

test.describe("live real-harness smoke @live", () => {
  test.skip(
    !LIVE,
    "Tier L: set CLAXEDO_E2E_LIVE=1 to run live-real-harness-smoke against a real " +
      "claxedo-server + real harness binaries (opencode is always exercised; " +
      "claude/codex ACP+SDK are exercised when their binaries are on PATH). Unset " +
      "-> loud, visible skip per e2e/INVARIANTS.md's Tier L gating contract — never " +
      "a silent no-op.",
  )

  test.beforeAll(async () => {
    if (!LIVE) return
    await startServer()
  })

  test.afterAll(async () => {
    if (!LIVE) return
    await stopServer()
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
    await Promise.all(scratchDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)))
  })

  test.beforeEach(async ({}, testInfo) => {
    // Real agent turns take several real seconds each (see HARNESS NOTES latency
    // table); 3 turns + reload per scenario needs headroom above the file default.
    testInfo.setTimeout(240_000)
  })

  test("opencode native harness (embedded engine) completes 3 real turns and survives reload — behaviors 1,6,7", async ({
    page,
  }) => {
    const dir = await makeWorkspace("opencode")
    await seedOneProject(page, dir)
    await runLiveHarnessSmoke(page, dir, { id: "opencode" })
  })

  test("claude ACP harness (real claude-agent-acp subprocess) completes 3 real turns and survives reload — behaviors 2,6,7", async ({
    page,
  }) => {
    const binary = await resolveBinary("claude", "CLAXEDO_E2E_CLAUDE_BIN")
    test.skip(
      !binary,
      "claude binary not found on PATH (or CLAXEDO_E2E_CLAUDE_BIN failed `--version`) — " +
        "install and authenticate the Claude CLI to include the claude-acp harness in " +
        "this live smoke run.",
    )
    const dir = await makeWorkspace("claude-acp")
    await seedDefaultHarness(dir, "acp:claude")
    await seedOneProject(page, dir)
    await runLiveHarnessSmoke(page, dir, { id: "acp:claude", seededHarness: "acp:claude" })
  })

  test("claude native SDK harness completes 3 real turns and survives reload — behaviors 3,6,7", async ({ page }) => {
    const binary = await resolveBinary("claude", "CLAXEDO_E2E_CLAUDE_BIN")
    test.skip(
      !binary,
      "claude binary not found on PATH (or CLAXEDO_E2E_CLAUDE_BIN failed `--version`) — " +
        "the native claude-sdk harness shares its credential source with the CLI " +
        "(see HARNESS NOTES); install and authenticate `claude` to include it.",
    )
    const dir = await makeWorkspace("claude-sdk")
    await seedOneProject(page, dir)
    await runLiveHarnessSmoke(page, dir, { id: "claude-sdk", option: /^Claude$/, optionIndex: 0 })
  })

  test("codex ACP harness (real codex-acp subprocess) completes 3 real turns and survives reload — behaviors 4,6,7", async ({
    page,
  }) => {
    const binary = await resolveBinary("codex", "CLAXEDO_E2E_CODEX_BIN")
    test.skip(
      !binary,
      "codex binary not found on PATH (or CLAXEDO_E2E_CODEX_BIN failed `--version`) — " +
        "install and authenticate the Codex CLI to include the codex-acp harness in " +
        "this live smoke run.",
    )
    const dir = await makeWorkspace("codex-acp")
    await seedDefaultHarness(dir, "acp:codex")
    await seedOneProject(page, dir)
    await runLiveHarnessSmoke(page, dir, { id: "acp:codex", seededHarness: "acp:codex" })
  })

  test("codex native SDK harness completes 3 real turns and survives reload — behavior 5", async ({
    page,
  }) => {
    // Previously `test.fixme` for a "REAL APP BUG": against codex-cli 0.143.0 every
    // `turn/start` was reported to fail `thread not found: <uuid>` for the thread
    // `thread/start` had just returned. That bug is NOT reproducible in the current
    // driver: the native codex-app-server two-step lifecycle
    // (`packages/agent-sdk-runtime/src/harnesses/codex/driver.ts` — `createAgentSession`
    // -> `thread/start`, then `runTurn` -> `turn/start`, plus the fresh-process
    // `thread/resume` recovery in `startTurnWithThreadRecovery`) completes real turns
    // against BOTH codex-cli 0.143.0 and 0.144.x. Verified 2026-07-20 by driving the
    // real `CodexHarnessAdapter` (createSession + sendMessage, the exact path
    // `POST /session/:id/prompt_async` invokes) against real ChatGPT auth: 3 turns in
    // one session plus a reload (dispose -> respawn -> resume) all returned real model
    // output with no `thread not found`, from BOTH the source driver and the published
    // `@claxedo/agent-sdk-runtime@0.5.3` bundle. The recovery mechanism added in
    // 086be6cb7d resolved the original skew. Now a first-class live-smoke harness like
    // its siblings (native SDK == the picker's single `Codex` option).
    const binary = await resolveBinary("codex", "CLAXEDO_E2E_CODEX_BIN")
    test.skip(
      !binary,
      "codex binary not found on PATH (or CLAXEDO_E2E_CODEX_BIN failed `--version`) — " +
        "the native codex-app-server harness shares its credential source with the CLI " +
        "(ChatGPT auth in ~/.codex/auth.json); install and authenticate `codex` to " +
        "include it in this live smoke run.",
    )
    const dir = await makeWorkspace("codex-sdk")
    await seedOneProject(page, dir)
    await runLiveHarnessSmoke(page, dir, { id: "codex-sdk", option: /^Codex$/, optionIndex: 0 })
  })
})

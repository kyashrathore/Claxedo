/**
 * SPEC: Live claxedo-mcp tools (Tier L)
 *
 * PURPOSE — `@claxedo/mcp` (`packages/claxedo-mcp`) is the first-party MCP server every
 * installed harness (Claude, Cursor, Codex, OpenCode) talks to for process management,
 * log/PTY retrieval, session-transcript retrieval, background session dispatch, log
 * summarization, and (desktop-gated) browser-pane control. This spec is the one place
 * that proves TWO things against a real, unmocked `claxedo-server` and a real,
 * subprocess-spawned `claxedo-mcp` server (no route mocks anywhere, per
 * `e2e/INVARIANTS.md`'s Tier L rule):
 *   (a) WIRING — that installing `claxedo-mcp` (real GitHub fetch of
 *       `kyashrathore/Claxedo@dev`'s `packages/claxedo-mcp`, the same materializer
 *       `live-agent-extensions-materialization.spec.ts` exercises through the
 *       marketplace UI) rewrites the package's own `CLAXEDO_SERVER_URL`/`OPENCODE_API_DIR`
 *       to the REAL installing server's own runtime values across every harness config
 *       target, and that this rewrite is gated on an EXACT (id, owner, repo, ref,
 *       package_path) match — a look-alike install is NOT silently treated as
 *       first-party and materializes the package's `mcp.json` verbatim.
 *   (b) TOOLS DO THEIR JOB — that each registered tool's observable effect is real: a
 *       real MCP client (the `@modelcontextprotocol/sdk` `Client` + `StdioClientTransport`,
 *       exactly what a harness does) spawns the real `claxedo-mcp` binary
 *       (`node --import tsx src/server.ts`, this package's own `"start"` script) and
 *       calls each tool against a real, running `claxedo-server`.
 *
 * STATE MODEL — two independent server lifetimes, deliberately NOT sharing one process:
 *   1. WIRING half: this file's OWN scratch `claxedo-server` (`startWiringServer()`),
 *      bound to a private port (`CLAXEDO_E2E_LIVE_MCP_WIRING_PORT`, default 3097 — NOT
 *      3001, see HARNESS NOTES for why this file never binds 3001) with
 *      `CLAXEDO_DATA_DIR`/`HOME` both pointed at throwaway temp directories — the exact
 *      isolation pattern `live-agent-extensions-materialization.spec.ts`'s
 *      `startScratchServer()` uses, for the same reason: a machine-scope install writes
 *      into `~/.claude.json`, `~/.cursor/mcp.json`, `~/.codex/config.toml`,
 *      `~/.config/opencode/opencode.jsonc` and must never touch the real developer's
 *      actual files.
 *   2. TOOLS half: the ALREADY-RUNNING ambient `claxedo-server` this whole shared e2e
 *      environment's Vite preview server (port 4455) is wired to (verified live: a real
 *      `bun`/`node --import tsx src/main.ts` process already listens on 127.0.0.1:3001,
 *      answering `/api/claxedo/health`). This file deliberately reuses it for the TOOLS
 *      half instead of spawning a second isolated backend — see HARNESS NOTES for the
 *      full reasoning — but every workspace-scoped tool call in this half targets a
 *      throwaway, freshly `git init`-ed directory (`makeWorkspace()`, registered via the
 *      real `GET /api/workspace/resolve?...&create=true` bootstrap call, the same
 *      precondition `live-real-harness-smoke.spec.ts`'s `registerWorkspace()` documents)
 *      and NO tool call in this half ever touches `os.homedir()` — process/get_logs/
 *      session_messages/spawn_session/summarize_logs only ever read/write inside the
 *      given `directory` or a virtual/central session, never `~`.
 *
 * ANATOMY — the MCP wire contract (`packages/claxedo-mcp/src/server.ts`), not a DOM:
 *   Tools: `process` (mutating, hidden in read-only mode), `get_logs`, `session_messages`
 *     (both always registered), `spawn_session`/`summarize_logs` (mutating, hidden in
 *     read-only mode), `browser_list_tabs`/`browser_get_console_logs`/`browser_screenshot`
 *     (always registered, read-only), `browser_evaluate_js`/`browser_navigate` (mutating,
 *     hidden in read-only mode) — `packages/claxedo-mcp/src/server.ts:210-250,473-548,683`
 *     and `browser-tools.ts:345-411`'s `registerBrowserTools`.
 *   Read-only gate: `CLAXEDO_MCP_READ_ONLY=1` (or `CLAXEDO_MCP_MODE=read-only`) —
 *     `packages/claxedo-mcp/src/tool-policy.ts`'s `claxedoMcpReadOnly()`.
 *   Desktop bridge gate: `CLAXEDO_DESKTOP_URL`/`CLAXEDO_DESKTOP_TOKEN` env — absent (the
 *     default outside the Electron desktop app) means every `browser_*` tool call returns
 *     the exact, stable string `DESKTOP_UNAVAILABLE_MESSAGE`
 *     (`packages/claxedo-mcp/src/desktop-request.ts:25-27`).
 *   First-party env-rewrite gate: `isFirstPartyClaxedoMcpInstall()`
 *     (`packages/agent-extensions/src/materialize.ts:118-126`) — id === "claxedo-mcp" AND
 *     source.type === "github" AND owner === "kyashrathore" AND repo.toLowerCase() ===
 *     "claxedo" AND ref === "dev" AND package_path === "packages/claxedo-mcp", ALL five
 *     fields, exactly. Any mismatch takes the verbatim-materialization path
 *     (`managedClaxedoMcpConfig`/`managedClaxedoMcpEnv` never run).
 *   Real persistence paths this spec reads directly (never through a DOM): per-directory
 *     process config is `.workspace-runtime/processes.jsonc`
 *     (`packages/workspace-runtime/src/managed-processes/manager.ts:461` — see HARNESS
 *     NOTES for why this is NOT `.claxedo/processes.jsonc`, the plan's literal wording);
 *     machine-scope MCP targets are `<HOME>/.claude.json`, `<HOME>/.cursor/mcp.json`,
 *     `<HOME>/.codex/config.toml` (TOML, `[mcp_servers.claxedo]` + inline `env = {...}`),
 *     `<HOME>/.config/opencode/opencode.jsonc` (`materializers/mcp.ts:56-94,164-190`).
 *
 * BEHAVIORS —
 *   1. Installing `claxedo-mcp` (real GitHub fetch of `kyashrathore/Claxedo@dev`'s
 *      `packages/claxedo-mcp`) via `POST /api/claxedo/agent-config/extensions` (the same
 *      real materializer path the marketplace UI calls, exercised here directly per the
 *      plan's "via spec 23's path or CLI") rewrites `env.CLAXEDO_SERVER_URL` to the
 *      INSTALLING SERVER's own real runtime URL and injects `env.OPENCODE_API_DIR` set to
 *      the project directory, across all four harness targets (claude, cursor, codex,
 *      opencode), for a project-scope install.
 *   2. A look-alike install — the exact same real, live-fetched source, differing ONLY in
 *      the requested package `id` (`claxedo-mcp-lookalike` instead of `claxedo-mcp`) — is
 *      NOT treated as the first-party install (`isFirstPartyClaxedoMcpInstall`'s `id`
 *      check fails) and materializes the fetched `mcp.json`'s `env` block byte-for-byte
 *      verbatim: `CLAXEDO_SERVER_URL` stays the literal fallback string
 *      `"http://127.0.0.1:3001"` baked into the real committed file, NOT the installing
 *      server's real (different) URL, and no `OPENCODE_API_DIR` is injected.
 *   3. [cited, not independently re-proven live] Credential stripping — every
 *      `CLAXEDO_*_TOKEN` key is removed from a first-party install's materialized env —
 *      is real, tested behavior at `packages/agent-extensions/src/install.test.ts:220-290`.
 *      This spec does not re-prove it live because the real, currently-committed
 *      `packages/claxedo-mcp/mcp.json` fixture declares no token fields to strip (see
 *      HARNESS NOTES).
 *   4. The `process` tool's `start`/`stop` actions drive the real per-directory process
 *      manager: `start` transitions a pre-configured process to `running` (real PID/PTY),
 *      `stop` transitions it back; the config is real, persisted, per-directory JSON at
 *      `.workspace-runtime/processes.jsonc`.
 *   5. [REAL APP BUG — `test.fixme`] The `process` tool's `add`/`update`/`remove` actions
 *      request the WRONG backend path. `handleProcess` (`process-handler.ts`) posts to the
 *      literal path `"/process"` (line 275) / `` `/process/${id}` `` (lines 299, 311) for
 *      add/update/remove, but the real `claxedo-server` only exposes process CRUD at
 *      `/api/wr/process` (confirmed live: `POST /process` on a real running server 404s;
 *      `POST /api/wr/process` — the SAME path `list`/`start`/`stop`/`restart` correctly
 *      use via `PROCESS_PATH` in `server.ts:43` — succeeds). Every `action: "add"` /
 *      `"update"` / `"remove"` call therefore always fails against a real backend. This
 *      spec's own live run reproduced it directly. See HARNESS NOTES for why the unit
 *      test suite never caught this.
 *   6. `get_logs` returns the real PTY tail of a running process (non-empty, and growing
 *      over real elapsed time) — proven structurally rather than by exact stdout-text
 *      match; see HARNESS NOTES for why an exact-text match is unreliable in this
 *      environment.
 *   7. `session_messages` with an explicit `session_id` returns the real transcript
 *      (`GET /session/:id/message`) — proven with a deterministic marker in the USER's own
 *      message text (this half needs no real model reply).
 *   8. `session_messages` with a `terminal_id` (no `session_id`) resolves a real
 *      terminal-agent binding via the real `GET/POST .../api/wr/hook/agent-lifecycle` +
 *      `GET .../hook/terminal-session` routes (`packages/workspace-runtime/src/routes/
 *      agent-hook.ts`) — the same real hook a CLI wrapper agent pings — and returns that
 *      bound session's transcript.
 *   9. `spawn_session` (no `workspace_id`, a virtual central-Pi sandbox) creates a real
 *      hybrid session via `POST /api/control/sessions` (loopback-only,
 *      `control-plane-session.ts:228-277`), returns `{session_id, app_url:
 *      "/s/<session_id>", prompt_dispatched: true}`, and the session is really registered
 *      (present in `GET /api/control/sessions`). The initial prompt IS really dispatched
 *      fire-and-forget. [gated, cited] This spec does NOT assert the prompt's reply
 *      renders (the oracle's reply-completion half) — central Pi sessions resolve a model
 *      backend only when `CLAXEDO_PI_MODEL_BACKEND=1` (or `CLAXEDO_PI_MODEL=...`) is set on
 *      the SERVING process (`central-session-runtime.ts:173-190`), which this file cannot
 *      set on the ambient shared server it reuses for this half (see STATE MODEL / HARNESS
 *      NOTES) — never silently claimed green.
 *  10. `summarize_logs` given raw `text` (skipping log fetch) always returns a non-empty
 *      MCP result, and its scratch "Log Summary" session is deleted (fire-and-forget
 *      `DELETE /session/:id` in a `finally`) shortly after the call returns, regardless of
 *      whether the underlying model turn succeeded or errored.
 *  10b. [REAL APP BUG — `test.fixme`] When the underlying model turn errors (this
 *      environment's ambient default model reliably does — see HARNESS NOTES),
 *      `summarize_logs` does NOT surface the intended legible `LLM error: ...` message; it
 *      crashes with a raw, unrelated `SyntaxError` text instead, root-caused live via a
 *      byte-level HTTP proxy: `httpRequest()` (`server.ts:66-67`) JSON-parses every
 *      `mode:"json"` response BEFORE checking `res.ok`, and `summarize_logs`'s empty-reply
 *      fallback (`server.ts:637-645`) calls `GET /session/:id/message/:messageId`, a route
 *      that does not exist on the real server (confirmed live: 404, plain-text body).
 *  11. `CLAXEDO_MCP_READ_ONLY=1` hides `process`, `spawn_session`, `summarize_logs`,
 *      `browser_evaluate_js`, `browser_navigate` from `tools/list`, while `get_logs`,
 *      `session_messages`, `browser_list_tabs`, `browser_get_console_logs`,
 *      `browser_screenshot` remain registered.
 *  12. Every `browser_*` tool returns the EXACT `DESKTOP_UNAVAILABLE_MESSAGE` string when
 *      no desktop bridge env (`CLAXEDO_DESKTOP_URL`/`CLAXEDO_DESKTOP_TOKEN`) is present —
 *      the only reachable case outside the Electron desktop app.
 *  13. [gated, cloud] The same graceful desktop-unavailable denial inside a Docker cloud
 *      sandbox — not executed in this run (`CLAXEDO_ENABLE_DOCKER_SANDBOX` unset), same
 *      gating contract `live-agent-extensions-materialization.spec.ts`'s cloud half uses.
 *
 * INVARIANTS — an unowned/pre-existing entry is never silently overwritten (shared with
 *   `live-agent-extensions-materialization.spec.ts`'s own invariant; not re-tested here,
 *   this file only exercises the first-party vs. non-first-party rewrite gate). No
 *   `waitForTimeout` is used as the sole guard of a negative — "add/update/remove 404"
 *   (behavior 5) is proven by an HTTP status code, not a timing guess; "no scratch session
 *   lingers" (behavior 10) is proven by a polled `GET /session` list, not a fixed sleep.
 *
 * HARNESS NOTES —
 *   - [ENVIRONMENT FINDING, same class `live-agent-extensions-materialization.spec.ts`'s
 *     SPEC block already documents] This shared e2e environment's Vite preview server
 *     (port 4455) bakes `VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:3001` at build time, and
 *     a REAL, already-running, ambient `claxedo-server` (a genuine developer-machine
 *     process, real `HOME`, real `CLAXEDO_DATA_DIR`) already owns port 3001. This file
 *     therefore NEVER attempts to bind 3001 itself (the WIRING half uses its own isolated
 *     port 3097) and NEVER drives the app's own browser UI (`page`) against either the
 *     ambient backend (mutating a real developer's real `~/.claude.json` etc. would be an
 *     install a human never asked for) or a self-spun isolated backend (the UI's baked
 *     `VITE_CLAXEDO_SERVER_URL` cannot be redirected per-test — confirmed by
 *     `live-agent-extensions-materialization.spec.ts`'s own investigation, and
 *     `live-real-harness-smoke.spec.ts`'s `seedOneProject()` comment independently
 *     confirms `page.addInitScript` cannot override it either). Consequence: this spec
 *     proves the REAL backend/filesystem state the Process panel and session sidebar
 *     render from (the process manager's real running/stopped status, the real
 *     `.workspace-runtime/processes.jsonc`, the real `GET /api/control/sessions`
 *     inventory) rather than driving those two DOM surfaces directly — the DOM-rendering
 *     half of behaviors 4 and 9 is OUT OF SCOPE for this run, not silently claimed.
 *     `visual_verified` for this spec reports honestly against that reduced scope.
 *   - The TOOLS half deliberately reuses the ambient shared backend (port 3001) instead of
 *     spawning its own, UNLIKE the WIRING half: every TOOLS-half action is scoped to a
 *     disposable `git init`-ed directory and never touches `os.homedir()` (process/
 *     get_logs/session_messages/spawn_session(virtual)/summarize_logs), so reusing the
 *     ambient backend does not risk the real developer's actual files — only the WIRING
 *     half's machine-scope MCP-config installs do, hence ITS isolation.
 *   - `.workspace-runtime/processes.jsonc` vs. the plan's `.claxedo/processes.jsonc`: the
 *     plan doc's spec-24 entry cites the legacy filename. The real, current source
 *     (`managed-processes/manager.ts:461-464`) migrated the canonical path to
 *     `.workspace-runtime/processes.jsonc`, keeping `.claxedo/processes.jsonc` (and
 *     `.opencode/processes.jsonc`) only as a one-time migration source. This spec asserts
 *     the CURRENT real path — documentation drift, not an app bug.
 *   - Behavior 5's unit-test blind spot: `packages/claxedo-mcp/src/process-handler.test.ts`
 *     stubs its own fake `http()` and asserts `httpCall.path === "/process"` (lines
 *     290-291, 367-368, 400-401) — the WRONG path is literally what the unit test expects,
 *     so it stays green while the real server 404s. Exactly the class of bug this Tier L
 *     effort exists to catch (mocked assertions enshrining the bug they should catch).
 *   - Behavior 6's exact-text limitation: a managed process's PTY in this environment runs
 *     inside a full interactive login shell with a themed prompt (visible ANSI OSC/CSI
 *     sequences, a styled multi-segment prompt, live-redrawn clock) rather than the bare
 *     command's stdout appearing as a clean, greppable line — confirmed live (`printf
 *     HELLO-WORLD-MARK` produced ~2KB of prompt-theme escape sequences around the command
 *     echo). Asserting a specific inline marker string in that tail is brittle; this spec
 *     asserts PTY-tail liveness (non-empty, growing across a real elapsed wait) instead,
 *     which is the structurally-provable claim the plan actually needs ("returns the real
 *     PTY tail").
 *   - Behavior 9/10's real model-turn instability in this shared ambient environment
 *     (found live): a plain `POST /session/:id/message` with no explicit provider/model
 *     against the ambient backend resolves to `anthropic/claude-sonnet-4-6`, which its own
 *     provider catalog rejects with `Model not found: anthropic/claude-sonnet-4-6`. This
 *     is an ambient environment/config issue (the workspace's default agent/model
 *     preference), not a `claxedo-mcp` bug, and out of this spec's scope to fix — but it IS
 *     what deterministically exercises `summarize_logs`'s empty-reply fallback path on
 *     every run in this environment, which is how behavior 10b's real bug (see above) was
 *     found and root-caused with certainty (a byte-level HTTP proxy inserted between
 *     claxedo-mcp and the real backend, capturing the exact 404 plain-text body). `spawn_
 *     session`'s central-Pi prompt is separately gated (see behavior 9) — an independent
 *     reason that half is not live-asserted, not a duplicate of this finding.
 *   - This spec requires real outbound network access to github.com for the WIRING half
 *     (same requirement `live-agent-extensions-materialization.spec.ts` documents) —
 *     verified live before authoring (`git ls-remote https://github.com/kyashrathore/
 *     Claxedo.git dev` resolved `00a533c2fb...`, matching this repo's own `dev` HEAD).
 *
 * OUT OF SCOPE — the marketplace UI install surface itself and its full per-harness
 *   lifecycle (install/disable/enable/uninstall/conflict) — `live-agent-extensions-
 *   materialization.spec.ts`; full browser-tool coverage inside an actual desktop app
 *   (the desktop repo's own tests, per the plan); the real-turn oracle for
 *   `spawn_session`/`summarize_logs` in an environment with a working default model (see
 *   HARNESS NOTES); Docker cloud-sandbox execution (gated, not run).
 */
import { execFile, spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { expect, test } from "@playwright/test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const execFileAsync = promisify(execFile)

const LIVE = process.env.CLAXEDO_E2E_LIVE === "1"
const DOCKER_SANDBOX = process.env.CLAXEDO_ENABLE_DOCKER_SANDBOX === "1"

const APP_DIR = path.resolve(import.meta.dirname, "../..")
const REPO_ROOT = path.resolve(APP_DIR, "../..")
const SERVER_DIR = path.join(REPO_ROOT, "packages", "claxedo-server")
const MCP_DIR = path.join(REPO_ROOT, "packages", "claxedo-mcp")

// Ambient shared backend (TOOLS half) — see SPEC block STATE MODEL / HARNESS NOTES for
// why this file reuses it instead of spawning its own.
const AMBIENT_PORT = Number(process.env.CLAXEDO_E2E_LIVE_BACKEND_PORT ?? 3001)
const AMBIENT_URL = `http://127.0.0.1:${AMBIENT_PORT}`

// Isolated scratch backend (WIRING half) — deliberately NOT 3001, see HARNESS NOTES.
const WIRING_PORT = Number(process.env.CLAXEDO_E2E_LIVE_MCP_WIRING_PORT ?? 3097)
const WIRING_URL = `http://127.0.0.1:${WIRING_PORT}`

const DESKTOP_UNAVAILABLE_MESSAGE =
  "Browser tabs require the Claxedo desktop app. " +
  "Ask the user to open a browser tab in the desktop client, then retry."

let wiringServer: ChildProcess | undefined
let wiringLog = ""
let wiringDataDir = ""
let wiringHomeDir = ""
const scratchDirs: string[] = []

async function waitForHealth(url: string, log: () => string, timeoutMs = 60_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const ok = await fetch(url).then((res) => res.ok).catch(() => false)
    if (ok) return
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`GATING: server did not become healthy at ${url} within ${timeoutMs}ms. Log tail:\n${log().slice(-3000)}`)
}

async function assertPortFree(port: number, label: string) {
  const found = await execFileAsync("lsof", ["-i", `:${port}`, "-sTCP:LISTEN", "-t"]).catch(() => undefined)
  const pids = found?.stdout.split("\n").map((line) => line.trim()).filter(Boolean) ?? []
  if (pids.length > 0) {
    throw new Error(
      `GATING: ${label} port ${port} is already owned by PID(s) ${pids.join(", ")} that this file did not spawn. ` +
        `Free it or set the matching override env var before retrying.`,
    )
  }
}

async function assertAmbientBackendHealthy() {
  const ok = await fetch(`${AMBIENT_URL}/api/claxedo/health`).then((res) => res.ok).catch(() => false)
  if (!ok) {
    throw new Error(
      `GATING: no healthy claxedo-server found at ${AMBIENT_URL} (the shared e2e environment's expected ambient ` +
        `backend — see this file's SPEC block STATE MODEL). This spec's TOOLS half requires it; start it before ` +
        `retrying, or point CLAXEDO_E2E_LIVE_BACKEND_PORT at a running one.`,
    )
  }
}

async function startWiringServer() {
  await assertPortFree(WIRING_PORT, "WIRING scratch claxedo-server")
  wiringDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-live-mcp-wiring-data-"))
  wiringHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-live-mcp-wiring-home-"))
  wiringServer = spawn(
    "node",
    ["--conditions=development", "--import", "../workspace-runtime/src/text-imports.mjs", "--import", "tsx", "src/main.ts"],
    {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        CLAXEDO_DATA_DIR: wiringDataDir,
        CLAXEDO_SERVER_PORT: String(WIRING_PORT),
        CLAXEDO_SERVER_URL: WIRING_URL,
        HOME: wiringHomeDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  wiringServer.stdout?.on("data", (chunk) => (wiringLog += chunk.toString()))
  wiringServer.stderr?.on("data", (chunk) => (wiringLog += chunk.toString()))
  await waitForHealth(`${WIRING_URL}/api/claxedo/health`, () => wiringLog)
}

async function stopWiringServer() {
  if (wiringServer && wiringServer.exitCode === null) {
    wiringServer.kill("SIGTERM")
    await new Promise<void>((resolve) => {
      wiringServer?.once("exit", () => resolve())
      setTimeout(resolve, 5_000)
    })
    if (wiringServer.exitCode === null) wiringServer.kill("SIGKILL")
  }
  wiringServer = undefined
}

async function makeWorkspace(name: string) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `claxedo-live-mcp-${name}-`)))
  scratchDirs.push(dir)
  await execFileAsync("git", ["init"], { cwd: dir })
  await fs.writeFile(path.join(dir, "README.md"), `live-claxedo-mcp-tools fixture: ${name}\n`)
  await execFileAsync("git", ["-c", "user.email=e2e@test.com", "-c", "user.name=e2e", "add", "-A"], { cwd: dir })
  await execFileAsync("git", ["-c", "user.email=e2e@test.com", "-c", "user.name=e2e", "commit", "-m", "init"], { cwd: dir })
  await registerWorkspace(dir)
  return dir
}

/** Same real precondition `live-real-harness-smoke.spec.ts`'s `registerWorkspace()` documents. */
async function registerWorkspace(dir: string) {
  const url = `${AMBIENT_URL}/api/workspace/resolve?directory=${encodeURIComponent(dir)}&create=true`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`GATING: failed to pre-register workspace ${dir} via ${url} (${res.status}) — ${await res.text().catch(() => "<no body>")}`)
  }
}

type McpClient = { client: Client; close: () => Promise<void> }

/** Spawns the REAL claxedo-mcp binary (its own "start" script) and connects a real MCP client. */
async function connectMcp(opts: { backendUrl: string; dir: string; extraEnv?: Record<string, string>; omitEnv?: string[] }): Promise<McpClient> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAXEDO_SERVER_URL: opts.backendUrl,
    OPENCODE_API_DIR: opts.dir,
    ...opts.extraEnv,
  }
  for (const key of opts.omitEnv ?? []) delete env[key]
  const transport = new StdioClientTransport({
    command: "node",
    args: ["--import", "tsx", "src/server.ts"],
    cwd: MCP_DIR,
    env: env as Record<string, string>,
  })
  const client = new Client({ name: "live-claxedo-mcp-tools-e2e", version: "1.0.0" }, { capabilities: {} })
  await client.connect(transport)
  return {
    client,
    close: async () => {
      await client.close().catch(() => {})
    },
  }
}

function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }> | undefined
  return content?.find((part) => part.type === "text")?.text ?? ""
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>
}

/** Extracts `env = { KEY = "value", ... }` from a codex TOML `[mcp_servers.claxedo]` section. */
function parseTomlInlineEnv(toml: string): Record<string, string> {
  const match = toml.match(/env\s*=\s*\{([^}]*)\}/)
  if (!match) return {}
  const out: Record<string, string> = {}
  const pairRe = /([A-Za-z0-9_-]+)\s*=\s*"((?:\\.|[^"\\])*)"/g
  let pair: RegExpExecArray | null
  while ((pair = pairRe.exec(match[1]!))) {
    out[pair[1]!] = pair[2]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  }
  return out
}

test.describe("live claxedo-mcp tools @live", () => {
  test.skip(
    !LIVE,
    "Tier L: set CLAXEDO_E2E_LIVE=1 to run live-claxedo-mcp-tools against a real claxedo-server " +
      "(the WIRING half spawns its own isolated instance; the TOOLS half reuses the ambient shared one) " +
      "and a real, subprocess-spawned claxedo-mcp server. Unset -> loud, visible skip per " +
      "e2e/INVARIANTS.md's Tier L gating contract — never a silent no-op.",
  )

  test.describe.configure({ mode: "serial" })

  test.beforeAll(async () => {
    if (!LIVE) return
    await assertAmbientBackendHealthy()
  })

  test.afterAll(async () => {
    if (!LIVE) return
    await Promise.all(scratchDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)))
  })

  test.beforeEach(async ({}, testInfo) => {
    testInfo.setTimeout(120_000)
  })

  // ---------------------------------------------------------------------
  // WIRING half — isolated scratch backend, never the ambient one.
  // ---------------------------------------------------------------------
  test.describe("wiring: env rewrite + first-party gate", () => {
    test.beforeAll(async () => {
      if (!LIVE) return
      await startWiringServer()
    })

    test.afterAll(async () => {
      if (!LIVE) return
      await stopWiringServer()
      if (wiringDataDir) await fs.rm(wiringDataDir, { recursive: true, force: true }).catch(() => undefined)
      if (wiringHomeDir) await fs.rm(wiringHomeDir, { recursive: true, force: true }).catch(() => undefined)
    })

    test("first-party claxedo-mcp install rewrites CLAXEDO_SERVER_URL and OPENCODE_API_DIR across all four harness targets — behavior 1", async () => {
      const projectDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-live-mcp-wiring-proj-")))
      scratchDirs.push(projectDir)

      const res = await fetch(`${WIRING_URL}/api/claxedo/agent-config/extensions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "https://github.com/kyashrathore/Claxedo/tree/dev/packages/claxedo-mcp",
          scope: "project",
          directory: projectDir,
          id: "claxedo-mcp",
          targets: ["opencode", "claude", "codex", "cursor"],
        }),
      })
      expect(res.status, await res.clone().text()).toBe(201)

      const claude = await readJson(path.join(projectDir, ".mcp.json"))
      const cursor = await readJson(path.join(projectDir, ".cursor", "mcp.json"))
      const opencode = await readJson(path.join(projectDir, ".opencode", "opencode.jsonc"))
      const codexToml = await fs.readFile(path.join(projectDir, ".codex", "config.toml"), "utf8")
      const codexEnv = parseTomlInlineEnv(codexToml)

      const claudeEnv = (claude.mcpServers as Record<string, { env?: Record<string, string> }>).claxedo?.env
      const cursorEnv = (cursor.mcpServers as Record<string, { env?: Record<string, string> }>).claxedo?.env
      const opencodeEnv = (opencode.mcp as Record<string, { environment?: Record<string, string> }>).claxedo?.environment

      for (const env of [claudeEnv, cursorEnv, opencodeEnv, codexEnv]) {
        expect(env?.CLAXEDO_SERVER_URL).toBe(WIRING_URL)
        expect(env?.OPENCODE_API_DIR).toBe(projectDir)
      }
    })

    test("a look-alike install (same real source, different id) is not first-party and materializes the mcp.json verbatim — behavior 2", async () => {
      const res = await fetch(`${WIRING_URL}/api/claxedo/agent-config/extensions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "https://github.com/kyashrathore/Claxedo/tree/dev/packages/claxedo-mcp",
          scope: "machine",
          id: "claxedo-mcp-lookalike",
          targets: ["cursor"],
        }),
      })
      expect(res.status, await res.clone().text()).toBe(201)

      const cursor = await readJson(path.join(wiringHomeDir, ".cursor", "mcp.json"))
      const cursorEnv = (cursor.mcpServers as Record<string, { env?: Record<string, string> }>).claxedo?.env
      // Verbatim: the literal fallback baked into the real committed mcp.json, NOT this
      // scratch server's own (different) URL — proves the first-party rewrite did NOT run.
      expect(cursorEnv).toEqual({ CLAXEDO_SERVER_URL: "http://127.0.0.1:3001" })
      expect(cursorEnv?.OPENCODE_API_DIR).toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------
  // TOOLS half — real MCP client(s) against the ambient shared backend.
  // ---------------------------------------------------------------------
  test.describe("tools do their job", () => {
    test("process tool start/stop drives the real process manager, persisted at .workspace-runtime/processes.jsonc — behavior 4", async () => {
      const dir = await makeWorkspace("process")
      const seed = await fetch(`${AMBIENT_URL}/api/wr/process?directory=${encodeURIComponent(dir)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-directory": dir },
        body: JSON.stringify({
          id: "proc_live_e2e",
          name: "live-e2e-proc",
          command: "node",
          args: ["-e", "let n=0;setInterval(()=>{console.log('tick-'+(n++))},200)"],
        }),
      })
      expect(seed.status, await seed.clone().text()).toBe(201)

      const jsonc = await readJson(path.join(dir, ".workspace-runtime", "processes.jsonc"))
      const configs = (jsonc as { processes?: Array<{ id: string; name: string }> }).processes ?? []
      expect(configs.some((c) => c.id === "proc_live_e2e")).toBe(true)

      const mcp = await connectMcp({ backendUrl: AMBIENT_URL, dir })
      try {
        const startResult = await mcp.client.callTool({ name: "process", arguments: { action: "start", id: "proc_live_e2e" } })
        expect(startResult.isError).toBeFalsy()
        expect(toolText(startResult)).toMatch(/started.*running/i)

        await expect
          .poll(async () => {
            const listResult = await mcp.client.callTool({ name: "process", arguments: { action: "list" } })
            return toolText(listResult)
          }, { timeout: 10_000 })
          .toMatch(/running/i)

        const stopResult = await mcp.client.callTool({ name: "process", arguments: { action: "stop", id: "proc_live_e2e" } })
        expect(stopResult.isError).toBeFalsy()
        expect(toolText(stopResult)).toMatch(/stopped/i)
      } finally {
        await mcp.close()
      }
    })

    test.fixme(
      "[REAL APP BUG] process tool add/update/remove request the wrong backend path and 404 against a real server — behavior 5",
      async () => {
        // packages/claxedo-mcp/src/process-handler.ts:275 (`action: "add"`),
        // :299 (`action: "update"`), :311 (`action: "remove"`) all POST/PUT/DELETE to the
        // literal bare path "/process" / `/process/${id}` instead of the real backend's
        // actual route, "/api/wr/process" (the same PROCESS_PATH constant list/start/stop/
        // restart correctly use — server.ts:43). Reproduced live: POST /process directly
        // against a real running claxedo-server 404s; POST /api/wr/process with the exact
        // same body succeeds (201). Confirmed this is not a fluke of this environment: the
        // package's own unit test (process-handler.test.ts:290-291,367-368,400-401) stubs
        // its fake http() and asserts the WRONG path is what gets called, so the bug is
        // invisible to CI. This is a real product bug, not a test gap — a fix belongs in
        // process-handler.ts's add/update/remove cases, not in this spec.
      },
    )

    test("get_logs returns a real, growing PTY tail for a running process — behavior 6", async () => {
      const dir = await makeWorkspace("get-logs")
      await fetch(`${AMBIENT_URL}/api/wr/process?directory=${encodeURIComponent(dir)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-directory": dir },
        body: JSON.stringify({
          id: "proc_live_logs",
          name: "live-e2e-logs",
          command: "node",
          args: ["-e", "let n=0;setInterval(()=>{console.log('tick-'+(n++))},200)"],
        }),
      })

      const mcp = await connectMcp({ backendUrl: AMBIENT_URL, dir })
      try {
        await mcp.client.callTool({ name: "process", arguments: { action: "start", id: "proc_live_logs" } })

        const firstLogs = await mcp.client.callTool({ name: "get_logs", arguments: { process_id: "proc_live_logs", lines: 200 } })
        expect(firstLogs.isError).toBeFalsy()
        const firstText = toolText(firstLogs)
        expect(firstText.length).toBeGreaterThan(0)

        await expect
          .poll(
            async () => {
              const later = await mcp.client.callTool({ name: "get_logs", arguments: { process_id: "proc_live_logs", lines: 400 } })
              return toolText(later).length
            },
            { timeout: 15_000 },
          )
          .toBeGreaterThan(firstText.length)

        await mcp.client.callTool({ name: "process", arguments: { action: "stop", id: "proc_live_logs" } })
      } finally {
        await mcp.close()
      }
    })

    test("session_messages returns the real transcript for an explicit session_id — behavior 7", async () => {
      const dir = await makeWorkspace("session-messages")
      const marker = `LIVE-MCP-SM-${Date.now()}`

      const sessionRes = await fetch(`${AMBIENT_URL}/session?directory=${encodeURIComponent(dir)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-directory": dir },
        body: JSON.stringify({ title: "live-claxedo-mcp-tools session_messages" }),
      })
      const session = (await sessionRes.json()) as { id: string }
      expect(session.id).toBeTruthy()

      await fetch(`${AMBIENT_URL}/session/${encodeURIComponent(session.id)}/message?directory=${encodeURIComponent(dir)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-directory": dir },
        body: JSON.stringify({ parts: [{ type: "text", text: marker }] }),
      })

      const mcp = await connectMcp({ backendUrl: AMBIENT_URL, dir })
      try {
        const result = await mcp.client.callTool({
          name: "session_messages",
          arguments: { session_id: session.id, format: "json" },
        })
        expect(result.isError).toBeFalsy()
        expect(toolText(result)).toContain(marker)
      } finally {
        await mcp.close()
      }
    })

    test("session_messages resolves a real terminal-agent binding via terminal_id — behavior 8", async () => {
      const dir = await makeWorkspace("session-messages-binding")
      const marker = `LIVE-MCP-BIND-${Date.now()}`
      const terminalId = `term_live_e2e_${Date.now()}`
      const tabId = `tab_live_e2e_${Date.now()}`

      const sessionRes = await fetch(`${AMBIENT_URL}/session?directory=${encodeURIComponent(dir)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-directory": dir },
        body: JSON.stringify({ title: "live-claxedo-mcp-tools binding" }),
      })
      const session = (await sessionRes.json()) as { id: string }

      await fetch(`${AMBIENT_URL}/session/${encodeURIComponent(session.id)}/message?directory=${encodeURIComponent(dir)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-directory": dir },
        body: JSON.stringify({ parts: [{ type: "text", text: marker }] }),
      })

      // Real terminal-agent registration, the same hook a CLI wrapper agent pings.
      const hookUrl =
        `${AMBIENT_URL}/api/wr/hook/agent-lifecycle?tabId=${encodeURIComponent(tabId)}&terminalId=${encodeURIComponent(terminalId)}` +
        `&eventType=Idle&sessionId=${encodeURIComponent(session.id)}&provider=opencode&directory=${encodeURIComponent(dir)}`
      const hookRes = await fetch(hookUrl, { headers: { "x-opencode-directory": dir } })
      expect(hookRes.ok, await hookRes.clone().text()).toBe(true)

      const mcp = await connectMcp({ backendUrl: AMBIENT_URL, dir })
      try {
        const result = await mcp.client.callTool({
          name: "session_messages",
          arguments: { terminal_id: terminalId, format: "json" },
        })
        expect(result.isError).toBeFalsy()
        expect(toolText(result)).toContain(marker)
      } finally {
        await mcp.close()
      }
    })

    test("spawn_session creates a real, registered central hybrid session and dispatches its prompt — behavior 9", async () => {
      const mcp = await connectMcp({ backendUrl: AMBIENT_URL, dir: process.cwd() })
      try {
        const result = await mcp.client.callTool({
          name: "spawn_session",
          arguments: { title: "live-claxedo-mcp-tools spawn_session", prompt: "Reply with exactly: SPAWN-OK" },
        })
        expect(result.isError).toBeFalsy()
        const parsed = JSON.parse(toolText(result)) as { session_id: string; app_url: string; prompt_dispatched: boolean }
        expect(parsed.session_id).toBeTruthy()
        expect(parsed.app_url).toBe(`/s/${parsed.session_id}`)
        expect(parsed.prompt_dispatched).toBe(true)

        // Real registration: the session is genuinely present in the control-plane
        // inventory, not just a locally-fabricated id.
        const listRes = await fetch(`${AMBIENT_URL}/api/control/sessions`)
        const list = (await listRes.json()) as { sessions?: Array<{ sessionID: string; host?: string }> }
        const found = list.sessions?.find((s) => s.sessionID === parsed.session_id)
        expect(found, `spawned session ${parsed.session_id} not found in GET /api/control/sessions`).toBeTruthy()
        expect(found?.host).toBe("central")

        // Reply-completion oracle intentionally NOT asserted here — see SPEC block
        // behavior 9 / HARNESS NOTES: central-Pi model resolution requires
        // CLAXEDO_PI_MODEL_BACKEND=1 on the SERVING process, which this file does not
        // control on the ambient shared backend it reuses for this half.
      } finally {
        await mcp.close()
      }
    })

    test("summarize_logs returns a non-empty result for provided text and cleans up its scratch session — behavior 10", async () => {
      const dir = await makeWorkspace("summarize-logs")
      const mcp = await connectMcp({ backendUrl: AMBIENT_URL, dir })
      try {
        const result = await mcp.client.callTool({
          name: "summarize_logs",
          arguments: {
            text:
              "Build failed with error: Cannot find module 'left-pad'.\n" +
              "Retrying dependency install...\n" +
              "Build succeeded on retry after 3 attempts.",
          },
        })
        const text = toolText(result)
        expect(text.length).toBeGreaterThan(0)

        // No scratch session lingers — the tool's finally-block DELETE is fire-and-forget,
        // so poll rather than assert instantaneously. Real regardless of whether the
        // underlying model turn succeeded or errored (behavior 10b) — the `finally` runs
        // either way.
        await expect
          .poll(
            async () => {
              const listRes = await fetch(`${AMBIENT_URL}/session?directory=${encodeURIComponent(dir)}`, {
                headers: { "x-opencode-directory": dir },
              })
              const sessions = (await listRes.json()) as Array<{ title?: string }>
              return sessions.some((s) => s.title === "Log Summary")
            },
            { timeout: 10_000 },
          )
          .toBe(false)
      } finally {
        await mcp.close()
      }
    })

    test.fixme(
      "[REAL APP BUG] summarize_logs never surfaces a raw JSON-parse crash for a failed/empty model reply — behavior 10b",
      async () => {
        // REAL APP BUG, root-caused live against this repo's real running claxedo-server
        // (a local HTTP proxy inserted between claxedo-mcp and the backend captured the
        // exact byte stream) — not a test gap. Two compounding defects in
        // packages/claxedo-mcp/src/server.ts:
        //   1. httpRequest() (server.ts:66-67) unconditionally JSON.parses the response
        //      body for mode:"json" BEFORE checking res.ok, so any non-OK response with a
        //      non-JSON body (plain text, HTML) throws a raw, unrelated
        //      SyntaxError instead of reaching the graceful `catch` branch that would
        //      otherwise surface a legible message.
        //   2. summarize_logs's fallback path (server.ts:637-645), reached whenever the
        //      first message response has no text part (e.g. the model turn itself
        //      errored — verified live: this ambient environment's default agent/model
        //      resolves to "anthropic/claude-sonnet-4-6", which its own provider catalog
        //      rejects with "Model not found: ..."), calls
        //      `GET /session/:id/message/:messageId` — a route that does not exist on the
        //      real server (confirmed live: 404, plain-text body "404 Not Found", not
        //      JSON).
        //   Combined: JSON.parse("404 Not Found") consumes the valid JSON number literal
        //   "404" (3 chars), skips the following whitespace, then throws exactly
        //   `Unexpected non-whitespace character after JSON at position 4` on the "N" of
        //   "Not" — which summarize_logs's own catch-all reports as "Failed to summarize
        //   logs: Unexpected non-whitespace character after JSON at position 4 (line 1
        //   column 5)" instead of the intended, legible "LLM error: Model not found: ..."
        //   message. Reproduced deterministically, in isolation (no other interference),
        //   against this repo's real running server. A fix belongs in httpRequest()
        //   (check res.ok before JSON.parse, or wrap the parse in try/catch) and/or in
        //   removing the dead fallback call to a route that does not exist — not in this
        //   spec.
      },
    )

    test("CLAXEDO_MCP_READ_ONLY=1 hides mutating tools from tools/list — behavior 11", async () => {
      const dir = await makeWorkspace("read-only")
      const mcp = await connectMcp({ backendUrl: AMBIENT_URL, dir, extraEnv: { CLAXEDO_MCP_READ_ONLY: "1" } })
      try {
        const tools = await mcp.client.listTools()
        const names = tools.tools.map((t) => t.name)
        for (const hidden of ["process", "spawn_session", "summarize_logs", "browser_evaluate_js", "browser_navigate"]) {
          expect(names, `expected "${hidden}" to be hidden in read-only mode`).not.toContain(hidden)
        }
        for (const visible of ["get_logs", "session_messages", "browser_list_tabs", "browser_get_console_logs", "browser_screenshot"]) {
          expect(names, `expected "${visible}" to remain registered in read-only mode`).toContain(visible)
        }
      } finally {
        await mcp.close()
      }
    })

    test("browser_* tools return the exact desktop-unavailable message with no desktop bridge — behavior 12", async () => {
      const dir = await makeWorkspace("browser-unavailable")
      const mcp = await connectMcp({
        backendUrl: AMBIENT_URL,
        dir,
        omitEnv: ["CLAXEDO_DESKTOP_URL", "CLAXEDO_DESKTOP_TOKEN"],
      })
      try {
        const listResult = await mcp.client.callTool({ name: "browser_list_tabs", arguments: {} })
        expect(listResult.isError).toBe(true)
        expect(toolText(listResult)).toBe(DESKTOP_UNAVAILABLE_MESSAGE)

        const screenshotResult = await mcp.client.callTool({ name: "browser_screenshot", arguments: { pane_id: "pane_1" } })
        expect(screenshotResult.isError).toBe(true)
        expect(toolText(screenshotResult)).toBe(DESKTOP_UNAVAILABLE_MESSAGE)

        const evalResult = await mcp.client.callTool({
          name: "browser_evaluate_js",
          arguments: { pane_id: "pane_1", expression: "1+1" },
        })
        expect(evalResult.isError).toBe(true)
        expect(toolText(evalResult)).toBe(DESKTOP_UNAVAILABLE_MESSAGE)

        const navigateResult = await mcp.client.callTool({
          name: "browser_navigate",
          arguments: { pane_id: "pane_1", url: "https://example.com" },
        })
        expect(navigateResult.isError).toBe(true)
        expect(toolText(navigateResult)).toBe(DESKTOP_UNAVAILABLE_MESSAGE)
      } finally {
        await mcp.close()
      }
    })

    test("browser_* tools return the same graceful denial inside a Docker cloud sandbox — behavior 13", async () => {
      test.skip(
        !DOCKER_SANDBOX,
        "Cloud half: set CLAXEDO_ENABLE_DOCKER_SANDBOX=1 to run browser_* denial checks inside a Docker cloud " +
          "sandbox workspace (behavior 13). Unset in this environment (same gating contract " +
          "live-agent-extensions-materialization.spec.ts's cloud half uses) -> loud, visible skip, never a " +
          "silent no-op. Not executed in this run.",
      )
      // Not implemented: this run's environment does not opt into Docker cloud sandbox
      // provisioning. See SPEC block OUT OF SCOPE.
    })
  })
})

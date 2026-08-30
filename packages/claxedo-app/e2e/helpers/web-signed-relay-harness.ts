/**
 * Shared boot/serve/drive primitives for the two Phase-4 web lanes,
 * `web-signed-cloud.spec.ts` and `web-signed-userhosted.spec.ts`
 * (`docs/plans/2026-08-06-001-test-full-matrix-real-e2e-plan.md`, Phase 4).
 *
 * WHY THIS FILE EXISTS — the plan's Phase 4 mandate is explicit: "Each lane is
 * a thin configuration wrapper over Phase 1's oracles; no journey logic is
 * duplicated per lane." The two lanes differ in exactly one axis — which
 * `CLAXEDO_E2E_RELAY_FIXTURE_ACCESS` the fixture boots as ("cloud" vs the
 * fixture's default "user-hosted") — and share every other concern: booting
 * `signed-browser-relay-fixture.mjs` with the scripted model wired in,
 * building and serving the REAL production web bundle against that fixture's
 * backend, seeding a browser session onto the fixture's workspace, and
 * driving the composer/rail/terminal DOM. `real-cloud-relay.spec.ts` and
 * `live-user-hosted-relay.spec.ts` each hand-rolled their own copy of most of
 * this before this file existed; this module is the single copy both new
 * lanes (and, incidentally, either of those two files, though this task does
 * not touch them) draw from.
 *
 * REAL BUILT WEB APP, NOT THE DEV SERVER — measured directly, 2026-08-06:
 * `node ./node_modules/vite/bin/vite.js build --config vite.cloud.config.ts
 * --outDir <dir>` with `VITE_CLAXEDO_SERVER_URL`/`VITE_CLAXEDO_E2E=1` set
 * completes in ~18s, and `vite preview --outDir <dir> --port <port>
 * --strictPort` serves the result and answers real requests immediately.
 * `getClaxedoServerUrl()` (`src/platform/api/api.ts:209`) reads
 * `import.meta.env.VITE_CLAXEDO_SERVER_URL`, which Vite inlines as a literal
 * string at BUILD time for a production bundle (unlike the dev server, where
 * it is merely read once at server start) — so the built bundle addresses the
 * fixture's backend by an absolute, cross-origin URL baked in at build time,
 * exactly the way `real-cloud-relay.spec.ts`'s and `live-user-hosted-
 * relay.spec.ts`'s DEV-server-based frontends do it, just compiled instead of
 * transformed on the fly. `vite.cloud.config.ts`'s `server.proxy` block is
 * irrelevant to either path for this reason — the client never relies on
 * same-origin proxying, so `vite preview` (which does not replay
 * `server.proxy`) needs no additional config. This closes the deviation those
 * two sibling specs recorded ("this spec runs its own dedicated vite frontend
 * DEV server... not a build") for the two lanes owned by this task.
 *
 * FIXED PORTS, NOT `freePort()` — Phase 4's own checklist requires "distinct
 * port block per lane; lanes shard in parallel" (plan line 254). A dynamically
 * allocated port cannot be known before the build that bakes it in, so each
 * lane's spec file passes ITS OWN fixed backend/preview port pair (overridable
 * by env, mirroring `real-harness-local.spec.ts`'s
 * `CLAXEDO_TIER_REAL_BACKEND_PORT` convention) rather than this module
 * allocating one dynamically.
 */
import { expect, test, type Locator, type Page, type Request } from "@playwright/test"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { SELECTORS as RAIL_SELECTORS } from "./rail-oracle"
import { claudeScriptedEnv, opencodeScriptedProviderConfig, type ScriptedModelServer } from "./scripted-model-server"

export const APP_DIR = path.resolve(import.meta.dirname, "..", "..")
export const REPO_ROOT = path.resolve(APP_DIR, "..", "..")
export const SERVER_DIR = path.join(REPO_ROOT, "packages", "claxedo-server")

export type SignedRelayAccess = "cloud" | "user-hosted"

/**
 * Mirrors `signed-browser-relay-fixture.mjs`'s stdout JSON shape — the exact
 * type both `real-cloud-relay.spec.ts` and `live-user-hosted-relay.spec.ts`
 * already declare locally. `controlPlaneToken` is required, not merely typed,
 * by the readiness parser below for the same reason those two files require
 * it: a fixture regression that stopped printing it would otherwise resolve
 * with `controlPlaneToken: undefined`, and every dependent test would fail
 * deep inside `gateReachesReady`'s timeout instead of a clear boot-time
 * GATING error.
 */
export type RelayFixtureInfo = {
  backendUrl: string
  relayUrl: string
  workspaceId: string
  hostId: string
  runtimeAccessToken: string
  directory: string
  role: string
  controlPlaneToken: string
  /** Application org id for the fixture workspace (`personal` unless collaborative). */
  orgId?: string
  /** Default team public id when `collaborativeOrg` was requested. */
  defaultTeamId?: string
  ownerActor?: {
    actor_id?: string
    actor_public_id?: string
    actor_name?: string
  }
}

export type RunningRelayFixture = {
  info: RelayFixtureInfo
  log(): string
  close(): Promise<void>
}

const childStops = new WeakMap<ChildProcess, Promise<void>>()

function signalChildTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }
  child.kill(signal)
}

async function stopChild(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode) return
  const current = childStops.get(child)
  if (current) return current
  const stopping = new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      signalChildTree(child, "SIGKILL")
      resolve()
    }, 8_000)
    child.once("exit", () => {
      clearTimeout(timeout)
      resolve()
    })
    signalChildTree(child, "SIGTERM")
  })
  childStops.set(child, stopping)
  await stopping
}

/**
 * Boots the real `signed-browser-relay-fixture.mjs` — real relay process,
 * real EdDSA JWT mint/verify, real `hosted-node` control plane on
 * `createSqliteCentralStore` (plan Phase 3) — with the scripted model
 * endpoint and (for the C4 harness-switch scenario) the scripted claude
 * endpoint wired into its OWN process env. Both reach the harness through the
 * exact mechanism `real-cloud-relay.spec.ts`'s HARNESS NOTES verified
 * directly: `harnessSpawnEnv` spreads `process.env` into every harness spawn,
 * and any subprocess the fixture's embedded/cloud runtime forks inherits this
 * process's environment, denylist-filtered for only nine Claxedo-internal
 * names.
 *
 * `access: "user-hosted"` omits `CLAXEDO_E2E_RELAY_FIXTURE_ACCESS` entirely
 * rather than setting it to the literal string — the fixture's own default
 * (`access = process.env.CLAXEDO_E2E_RELAY_FIXTURE_ACCESS === "cloud" ? ...
 * : "user-hosted"`) already resolves to user-hosted on absence, and setting
 * an env var to `undefined` in a spawn's `env` object serializes to nothing
 * usable across the trip to a child process on some platforms — omitting the
 * key entirely is unambiguous.
 */
export async function startSignedRelayFixture(opts: {
  access: SignedRelayAccess
  backendPort: number
  scripted: ScriptedModelServer
  claudeConfigDir: string
  /** When set, fixture creates a collaborative org + default team and scopes the workspace to it. */
  collaborativeOrg?: { name: string }
  extraEnv?: Record<string, string>
}): Promise<RunningRelayFixture> {
  let log = ""
  const child = spawn(
    "node",
    [
      "--conditions=development",
      "--import",
      "./src/text-imports.mjs",
      "--import",
      "tsx",
      "src/signed-browser-relay-fixture.mjs",
    ],
    {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        CLAXEDO_E2E_BACKEND_PORT: String(opts.backendPort),
        ...(opts.access === "cloud" ? { CLAXEDO_E2E_RELAY_FIXTURE_ACCESS: "cloud" } : {}),
        ...(opts.collaborativeOrg?.name
          ? { CLAXEDO_E2E_COLLABORATIVE_ORG_NAME: opts.collaborativeOrg.name }
          : {}),
        OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeScriptedProviderConfig(opts.scripted.v1Url)),
        TIER_REAL_API_KEY: "test-key",
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        ...claudeScriptedEnv(opts.scripted.url, opts.claudeConfigDir),
        ...opts.extraEnv,
      },
      // A dedicated process group lets teardown terminate the fixture and all
      // subprocesses it owns. The stdin pipe is also a parent-death signal:
      // EOF reaches the fixture even when this Playwright worker is killed.
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    },
  )

  let info: RelayFixtureInfo
  try {
    info = await new Promise<RelayFixtureInfo>((resolve, reject) => {
      let settled = false
      let stdout = ""
      const finish = (err: Error) => {
        if (settled) return
        settled = true
        reject(err)
      }
      const timeout = setTimeout(() => {
        finish(new Error(`GATING: signed relay fixture (access=${opts.access}) did not start within 120s.\n${log}`))
      }, 120_000)
      child.stdout?.on("data", (chunk) => {
        const text = chunk.toString()
        log += text
        stdout += text
        for (const line of stdout.split("\n")) {
          if (settled || !line.trim()) continue
          try {
            const parsed = JSON.parse(line) as RelayFixtureInfo
            if (!parsed.backendUrl || !parsed.relayUrl || !parsed.workspaceId || !parsed.controlPlaneToken) continue
            settled = true
            clearTimeout(timeout)
            resolve(parsed)
          } catch {
            continue
          }
        }
      })
      child.stderr?.on("data", (chunk) => (log += chunk.toString()))
      child.once("exit", (code, signal) => {
        clearTimeout(timeout)
        finish(
          new Error(
            `GATING: signed relay fixture (access=${opts.access}) exited before starting (${code ?? signal}).\n${log}`,
          ),
        )
      })
      child.once("error", finish)
    })
  } catch (error) {
    await stopChild(child)
    throw error
  }

  // WARM-UP, ported verbatim from `live-user-hosted-relay.spec.ts`'s
  // `startFixture` — a REAL product cold-start race, not a test artifact.
  // That file's HARNESS NOTES: "the embedded workspace-runtime's `opencode`
  // engine lazy-boots on first use (`ensureEmbeddedWorkspaceRuntime` in
  // `embedded-workspace-runtime.ts`). The FIRST `/session` request to land
  // during that boot window intermittently 500s ... or, more severely,
  // surfaces as the UI's own 'opencode exited during startup' error."
  // MISSING here initially (this task's own `startSignedRelayFixture` did
  // not port it) reproduced exactly that shape live 2026-08-06: journeyA2's
  // first-ever real send on a freshly booted user-hosted fixture silently
  // created no session row within a 20s window, deterministically, even in
  // total isolation with a fresh backend (ruling out cross-test flakiness).
  // Cloud mode is not known to need this (`startCloudRuntime` performs its
  // own health probe before this function ever returns), but doing it
  // unconditionally is harmless — a few no-op retries at worst.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await fetch(`${info.relayUrl}/workspaces/${info.workspaceId}/session`, {
      headers: { authorization: `Bearer ${info.runtimeAccessToken}` },
    }).catch(() => undefined)
    if (res?.ok) break
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }

  return { info, log: () => log, close: () => stopChild(child) }
}

export type RunningWebApp = {
  url: string
  close(): Promise<void>
}

/**
 * Builds the REAL production web bundle pointed at `backendUrl` (baked in at
 * build time, see file header) and serves it via `vite preview`. Invoked
 * directly against `vite`'s own CLI entry rather than the `bun run build`
 * npm-script alias so `--outDir` can be overridden per lane — two lanes
 * building concurrently into the package's single default `dist/` would
 * clobber each other.
 */
export async function buildAndServeWebApp(opts: {
  backendUrl: string
  outDir: string
  previewPort: number
}): Promise<RunningWebApp> {
  let buildLog = ""
  await new Promise<void>((resolve, reject) => {
    const build = spawn(
      "node",
      ["./node_modules/vite/bin/vite.js", "build", "--config", "vite.cloud.config.ts", "--outDir", opts.outDir],
      {
        cwd: APP_DIR,
        env: {
          ...process.env,
          VITE_CLAXEDO_SERVER_URL: opts.backendUrl,
          // Keeps the e2e-only harness seams (test-auth bypass via
          // `__CLAXEDO_TEST_AUTH_TOKEN__`, the `/__e2e/*` routes) alive in the
          // production bundle — tree-shaken out of any build that does NOT
          // set this flag, so real production is unaffected
          // (`playwright.config.ts`'s own production-preview comment).
          VITE_CLAXEDO_E2E: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    build.stdout?.on("data", (chunk) => (buildLog += chunk.toString()))
    build.stderr?.on("data", (chunk) => (buildLog += chunk.toString()))
    build.once("exit", (code) => {
      if (code === 0) return resolve()
      reject(new Error(`GATING: vite build (outDir=${opts.outDir}) exited ${code}.\n${buildLog}`))
    })
    build.once("error", reject)
  })

  let previewLog = ""
  const preview = spawn(
    "node",
    [
      "./node_modules/vite/bin/vite.js",
      "preview",
      "--config",
      "vite.cloud.config.ts",
      "--outDir",
      opts.outDir,
      "--port",
      String(opts.previewPort),
      "--strictPort",
      "--host",
      "127.0.0.1",
    ],
    {
      cwd: APP_DIR,
      env: { ...process.env, VITE_CLAXEDO_SERVER_URL: opts.backendUrl, VITE_CLAXEDO_E2E: "1" },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    },
  )

  const url = `http://127.0.0.1:${opts.previewPort}`
  try {
    // URL polling alone can be answered by a stale preview that already owns
    // the fixed lane port while THIS child is still failing asynchronously.
    // First require the spawned child to announce its own bound listener.
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        preview.off("exit", onExit)
        preview.off("error", onError)
        error ? reject(error) : resolve()
      }
      const inspect = (chunk: Buffer | string) => {
        previewLog += chunk.toString()
        const plain = previewLog.replace(/\u001b\[[0-9;]*m/g, "")
        if (plain.split("\n").some((line) => line.includes("Local:") && line.includes(url))) finish()
      }
      const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
        finish(new Error(`GATING: vite preview (port=${opts.previewPort}) exited before binding (${code ?? signal}).\n${previewLog}`))
      const onError = (error: Error) => finish(error)
      const timeout = setTimeout(
        () => finish(new Error(`GATING: vite preview (port=${opts.previewPort}) did not announce its listener.\n${previewLog}`)),
        45_000,
      )
      preview.stdout?.on("data", inspect)
      preview.stderr?.on("data", inspect)
      preview.once("exit", onExit)
      preview.once("error", onError)
    })

    const healthy = await fetch(url, { signal: AbortSignal.timeout(3_000) })
      .then((r) => r.ok)
      .catch(() => false)
    if (!healthy) throw new Error(`GATING: child-owned vite preview at ${url} did not become healthy.\n${previewLog}`)
  } catch (error) {
    await stopChild(preview)
    throw error
  }

  return {
    url,
    close: () => stopChild(preview),
  }
}

/**
 * Seeds the browser onto the fixture's workspace as a real relay-backed
 * target, keyed BOTH by the `workspace:<id>` ref and by the raw directory —
 * the same belt-and-suspenders shape `real-cloud-relay.spec.ts`'s
 * `seedWorkspace` uses (see that file's inline comments for the two concrete
 * failure modes each key independently guards against: `placementFor`/
 * `workspaceIdFromRef` needing the ref shape, and a path-keyed resolve
 * missing the row or aliasing a `/private/var` symlink into a second
 * workspace). `kind` is threaded through so ONE function serves both lanes.
 */
export async function seedWorkspace(
  page: Page,
  info: RelayFixtureInfo,
  kind: SignedRelayAccess,
  authUser?: { id: string; fullName?: string },
) {
  await page.addInitScript(
    (seed: RelayFixtureInfo & {
      kind: SignedRelayAccess
      authUserId?: string
      authUserFullName?: string
    }) => {
      localStorage.clear()
      localStorage.setItem("opencode.terminal.renderer", "dom")
      if (seed.orgId && seed.orgId !== "personal") {
        localStorage.setItem("claxedo.activeOrgId", seed.orgId)
      }
      if (seed.defaultTeamId) {
        localStorage.setItem("claxedo.activeTeamId", seed.defaultTeamId)
      }
      const w = window as typeof window & {
        __CLAXEDO_TEST_AUTH_TOKEN__?: string
        __CLAXEDO_TEST_AUTH_USER__?: { id: string; fullName?: string; primaryEmailAddress?: { emailAddress: string } }
      }
      w.__CLAXEDO_TEST_AUTH_TOKEN__ = seed.controlPlaneToken
      w.__CLAXEDO_TEST_AUTH_USER__ = {
        id: seed.authUserId ?? "user_browser",
        ...(seed.authUserFullName
          ? {
              fullName: seed.authUserFullName,
              primaryEmailAddress: { emailAddress: `${seed.authUserId ?? "user_browser"}@claxedo.test` },
            }
          : {}),
      }
      const ref = `workspace:${seed.workspaceId}`
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [],
          projects: { local: [{ worktree: ref, expanded: true, sandboxes: [seed.workspaceId] }] },
          lastProject: {},
          workspaceServer: {},
          closedProjects: {},
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:globalSync.project",
        JSON.stringify({
          value: [
            {
              // Must match `signed-browser-relay-fixture.mjs`'s `projectId`.
              // Signed bootstrap inventory overrides the display name, but
              // create-time rail upserts still resolve project id from this
              // client catalog — a mismatched id never matches the project-
              // scoped session-list query and the live row never appears.
              id: "proj_signed_browser_relay",
              name: `Web Signed ${seed.kind}`,
              worktree: ref,
              sandboxes: [seed.workspaceId],
              workspaces: {
                [ref]: {
                  id: seed.workspaceId,
                  kind: seed.kind,
                  workspace_name: `Web Signed ${seed.kind}`,
                  directory: seed.directory,
                },
                [seed.directory]: {
                  id: seed.workspaceId,
                  kind: seed.kind,
                  workspace_name: `Web Signed ${seed.kind}`,
                  directory: seed.directory,
                },
                [seed.workspaceId]: {
                  id: seed.workspaceId,
                  kind: seed.kind,
                  workspace_name: `Web Signed ${seed.kind}`,
                  directory: seed.directory,
                },
              },
            },
          ],
        }),
      )
    },
    {
      ...info,
      kind,
      ...(authUser
        ? {
            authUserId: authUser.id,
            ...(authUser.fullName ? { authUserFullName: authUser.fullName } : {}),
          }
        : {}),
    },
  )
}

export function sessionRoute(info: RelayFixtureInfo) {
  return `/w/${encodeURIComponent(info.workspaceId)}/session`
}

/** Behavior common to every scenario: the connect gate reaches a usable, non-provisioning composer. */
export async function gateReachesReady(page: Page, timeoutMs = 60_000): Promise<Locator> {
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: timeoutMs })
  await expect(page.locator('[data-component="cloud-startup-view"]')).toHaveCount(0, { timeout: timeoutMs })
  const input = page
    .getByRole("textbox", { name: /Ask anything/i })
    .filter({ visible: true })
    .last()
  await expect(input).toBeVisible({ timeout: timeoutMs })
  await expect(input).toHaveAttribute("contenteditable", "true")
  return input
}

/** Wait for the connection authority to project the role minted by the signed control plane. */
export async function waitForWorkspaceRole(
  page: Page,
  workspaceId: string,
  role: "owner" | "editor" | "viewer" | "admin" = "owner",
) {
  await page.waitForFunction(
    ({ id, expectedRole }) => {
      const scope = window as typeof window & {
        __claxedoConnections?: {
          snapshot?: () => Record<string, {
            status?: string
            rolePlacement?: { state?: string; role?: string }
          }>
        }
      }
      const row = scope.__claxedoConnections?.snapshot?.()?.[id]
      return row?.status === "ready"
        && row.rolePlacement?.state === "role-known"
        && row.rolePlacement.role === expectedRole
    },
    { id: workspaceId, expectedRole: role },
    { timeout: 60_000 },
  )
}

export function composerInput(page: Page): Locator {
  return page
    .getByRole("textbox", { name: /Ask anything/i })
    .filter({ visible: true })
    .last()
}

/**
 * Contenteditable DOM text is not the composer's authoritative state. A
 * `.fill()` can make the node look correct while Solid's input owner still
 * has an empty prompt, so the enabled-looking submit click becomes a no-op.
 * Clear through the normal input event, then send real keystrokes every time.
 */
export async function composeText(page: Page, input: Locator, text: string) {
  await input.click()
  await input.fill("")
  await input.pressSequentially(text)
  await expect(input).toContainText(text, { timeout: 10_000 })
}

/**
 * Picks "Scripted Model" in the composer's model control.
 *
 * Every harness uses the unified `[data-action="prompt-harness-model"]` picker.
 * A run that skipped this step could render a bundled model's reply while the
 * scripted server logged zero requests, so the selection is asserted directly.
 */
export async function selectScriptedModel(page: Page) {
  const control = page.locator('[data-action="prompt-harness-model"]:visible').last()
  await expect(control, "the composer's harness+model control never appeared").toBeVisible({ timeout: 30_000 })
  await control.click()
  const popover = page.locator('[data-component="harness-model-picker"]')
  await expect(popover, "the harness/model picker popover never opened").toBeVisible({ timeout: 15_000 })
  const search = page.getByRole("textbox", { name: /Search models/i }).last()
  await expect(search, "the harness/model picker's search box never appeared").toBeVisible({ timeout: 20_000 })
  await search.fill("Scripted")
  const option = page.getByText(/^Scripted Model$/i).last()
  await expect(
    option,
    '"Scripted Model" is missing from the picker — see opencodeScriptedProviderConfig\'s doc on release_date visibility gating',
  ).toBeVisible({ timeout: 20_000 })

  // Settle beat before the click — MEASURED 2026-08-06: the filtered list can
  // still be re-rendering for a fraction of a second right after `fill()`
  // (React-style DOM-node replacement, not merely re-styling), which
  // intermittently raced a same-frame `.click()` into "element was detached,
  // retrying". A bounded plain re-click (re-resolving the locator fresh each
  // time — never reusing a handle across attempts, and never pressing
  // Escape/reopening the popover, which risks discarding whatever draft
  // state the app associates with that keypress) is deliberately the
  // smallest fix: a prior version of this function DID reopen-on-failure and
  // was pulled after this task's own testing correlated it with sessions
  // silently never reaching the server — though a second isolated check
  // reproduced a similarly-shaped stall on THIS simpler version too, under
  // the same heavily loaded machine (`uptime` showed load average 4-6 with
  // ~660 processes and 4 other logged-in sessions at the time), so that
  // correlation should be read as "the reopen shape is not worth the risk
  // it was pulled for," not as a proven root cause — the flicker itself is
  // real relay-hop latency this suite cannot eliminate, only absorb.
  const deadline = Date.now() + 20_000
  let lastErr: unknown
  for (;;) {
    await page.waitForTimeout(300)
    try {
      await page
        .getByText(/^Scripted Model$/i)
        .last()
        .click({ timeout: 5_000 })
      lastErr = undefined
      break
    } catch (err) {
      lastErr = err
      if (Date.now() > deadline) break
    }
  }
  if (lastErr) {
    expect(false, `"Scripted Model" click never landed: ${String(lastErr)}`).toBe(true)
  }
  await expect(control, 'harness+model control never adopted "Scripted Model"').toContainText(/Scripted Model/i, {
    timeout: 20_000,
  })
}

export function submitControl(page: Page): Locator {
  return page.locator('[data-action="prompt-submit"]:visible').last()
}

export async function submitDraft(page: Page): Promise<string> {
  const submit = submitControl(page)
  await expect(submit, "no submit control").toBeVisible({ timeout: 10_000 })
  await expect(submit, "submit stayed disabled").toBeEnabled({ timeout: 10_000 })
  const postRequests: Array<{ url: string; status?: number }> = []
  const onRequest = (request: Request) => {
    if (request.method() === "POST") {
      const entry: { url: string; status?: number } = { url: request.url() }
      postRequests.push(entry)
      void request.response().then((response) => {
        if (response) entry.status = response.status()
      }).catch(() => undefined)
    }
  }
  page.on("request", onRequest)
  const createdResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/session") &&
      response.status() === 201,
    { timeout: 20_000 },
  )
  await submit.click()
  const response = await createdResponse.catch(async (err) => {
    page.off("request", onRequest)
    const routing = await page.evaluate(() => {
      const scope = window as typeof window & {
        __claxedoConnections?: { snapshot?: () => unknown }
        __claxedoQueryClient?: {
          getQueryCache(): {
            getAll(): Array<{ queryKey: unknown; state: { data?: unknown } }>
          }
        }
      }
      const projectQueries = scope.__claxedoQueryClient?.getQueryCache().getAll()
        .filter((query) => JSON.stringify(query.queryKey).toLowerCase().includes("project"))
        .map((query) => ({ key: query.queryKey, data: query.state.data })) ?? []
      return {
        connections: scope.__claxedoConnections?.snapshot?.(),
        projectQueries,
        workspaceHeaders: [...document.querySelectorAll<HTMLElement>("[data-workspace-id]")]
          .map((element) => element.dataset.workspaceId)
          .filter(Boolean),
      }
    }).catch((diagnosticError) => ({ diagnosticError: String(diagnosticError) }))
    throw new Error(
      `GATING: never observed the authoritative 201 POST .../session response — ${String(err)}; ` +
      `postRequests=${JSON.stringify(postRequests).slice(0, 4_000)}; ` +
      `routing=${JSON.stringify(routing).slice(0, 8_000)}`,
    )
  })
  page.off("request", onRequest)
  const created = (await response.json()) as { id?: unknown }
  if (typeof created.id !== "string" || !created.id) {
    throw new Error(`GATING: POST .../session omitted its canonical session id: ${JSON.stringify(created)}`)
  }
  return created.id
}

/**
 * Every SUBSEQUENT send in an already-open session (as opposed to
 * `submitDraft`'s first send on a brand-new draft) — same enabled-wait
 * `submitDraft` does, factored out so no call site can regress to a bare
 * `submitControl(page).click()`.
 *
 * REQUIRED, not a style preference — MEASURED live 2026-08-06: a bare
 * `.click()` right after `composeText()` intermittently landed on the
 * button while it was still momentarily disabled (composer validation
 * settling a beat after the text lands), especially right after
 * `page.reload()`. Playwright's auto-actionability wait does not cover a
 * CUSTOM disabled affordance the way `toBeEnabled()` does, so the click
 * silently no-ops — reproduced deterministically as A2's second turn never
 * completing, in isolation, with a freshly booted backend (ruling out cross-
 * test flakiness as the cause).
 */
export async function sendSubsequentMessage(page: Page) {
  const submit = submitControl(page)
  await expect(submit, "submit control never became enabled for a subsequent send").toBeEnabled({ timeout: 10_000 })
  await submit.click()
}

export async function currentSessionIds(page: Page): Promise<string[]> {
  const ids = await page
    .locator(RAIL_SELECTORS.allSessionRows)
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-session-id")))
  return ids.filter((id): id is string => !!id)
}

/**
 * B1's row-appears-live proof needs the session id the app just minted. Web
 * lanes DO have a URL to correlate against (`sessionUrlPattern` in
 * `real-harness-local.spec.ts`) — but relying on `page.url()` here would
 * silently stop proving the RAIL announced the row (defects 1/2/7's actual
 * symptom) and start proving only client-side navigation, which a broken
 * rail-invalidation path can satisfy on its own. Diffing the rail's own
 * `data-session-id` set (same technique `desktop-unsigned-embedded.spec.ts`
 * uses, where no URL exists at all) keeps this lane's B1 proof identical in
 * kind to every other lane's.
 */
export async function waitForNewSessionId(page: Page, before: string[], timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ids = await currentSessionIds(page)
    const found = ids.find((id) => !before.includes(id))
    if (found) return found
    if (Date.now() > deadline) {
      throw new Error(
        `GATING: no new rail session row appeared within ${timeoutMs}ms. Rows seen: ${JSON.stringify(ids)}`,
      )
    }
    await page.waitForTimeout(200)
  }
}

/** Same placeholder-id exclusion as `desktop-unsigned-embedded.spec.ts`'s `waitForNewTerminalId` — see that file's doc for why both `"new"` and `pending-*` must be excluded. */
export async function waitForNewTerminalId(page: Page, before: string[], timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ids = await page
      .locator('[data-testid="rail-sidebar-terminal-row"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-terminal-id")))
    const found = ids.find(
      (id): id is string => !!id && id !== "new" && !id.startsWith("pending-") && !before.includes(id),
    )
    if (found) return found
    if (Date.now() > deadline) {
      throw new Error(`GATING: no new terminal row appeared within ${timeoutMs}ms. Rows seen: ${JSON.stringify(ids)}`)
    }
    await page.waitForTimeout(200)
  }
}

/** Ensures the rail is pinned open so terminal rows are visible in the sidebar tree. */
export async function ensureRailPinnedOpen(page: Page) {
  const sidebar = page.locator('[data-testid="rail-sidebar"]')
  // rail-sidebar.tsx sets `data-pinned={docked() ? "" : undefined}` — presence
  // means pinned (empty string), not the literal `"true"`. Treating `""` as
  // unpinned used to click Hide Sidebar and collapse the rail mid-journey.
  if ((await sidebar.getAttribute("data-pinned")) !== null) return

  // When unpinned, the in-rail Hide control is unmounted; the workbench header
  // owns "Show Sidebar" (workbench-shell-header.tsx).
  const show = page.getByRole("button", { name: "Show Sidebar" })
  if (await show.isVisible().catch(() => false)) {
    await show.click()
  }
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if ((await sidebar.getAttribute("data-pinned")) !== null) return
    await page.waitForTimeout(100)
  }
  throw new Error("GATING: rail sidebar stayed unpinned after Show Sidebar")
}

async function expandVisibleDisclosures(
  page: Page,
  headerTestId: "project-header" | "workspace-header",
  expandLabel: string,
  collapseLabel: string,
) {
  const headers = page.locator(`[data-testid="${headerTestId}"]`)
  const count = await headers.count()
  let expanded = 0
  for (let i = 0; i < count; i++) {
    const header = headers.nth(i)
    if (!(await header.isVisible().catch(() => false))) continue
    const disclosure = header.locator(`[aria-label="${expandLabel}"], [aria-label="${collapseLabel}"]`)
    if ((await disclosure.count()) === 0) continue
    if ((await disclosure.getAttribute("aria-expanded")) !== "true") {
      await disclosure.click()
    }
    await expect(disclosure, `${headerTestId} never expanded`).toHaveAttribute("aria-expanded", "true", {
      timeout: 10_000,
    })
    expanded++
  }
  return expanded
}

/** Expands project/workspace sections so nested terminal rows are visible, not just present in the DOM. */
export async function ensureWorkspaceSectionExpanded(page: Page, info: RelayFixtureInfo) {
  await ensureRailPinnedOpen(page)

  // Default "Group by: Project" mode renders terminal rows under project-header
  // (ProjectBlock) — there is no workspace-header in that tree at all.
  const projectsExpanded = await expandVisibleDisclosures(
    page,
    "project-header",
    "Expand project",
    "Collapse project",
  )

  const candidates = [`workspace:${info.workspaceId}`, info.directory, info.workspaceId]
  for (const workspaceDir of candidates) {
    const header = page.locator(`[data-testid="workspace-header"][data-workspace-id="${workspaceDir}"]`)
    if ((await header.count()) === 0) continue
    await expect(header, `workspace header for "${workspaceDir}" never became visible`).toBeVisible({
      timeout: 15_000,
    })
    const disclosure = header.locator('[aria-label="Expand workspace"], [aria-label="Collapse workspace"]')
    if ((await disclosure.getAttribute("aria-expanded")) !== "true") {
      await disclosure.click()
    }
    await expect(disclosure, `workspace "${workspaceDir}" never expanded`).toHaveAttribute("aria-expanded", "true", {
      timeout: 10_000,
    })
    return
  }

  // Workspace-group mode / nested signed inventory: expand any visible workspace header.
  const workspacesExpanded = await expandVisibleDisclosures(
    page,
    "workspace-header",
    "Expand workspace",
    "Collapse workspace",
  )
  if (projectsExpanded > 0 || workspacesExpanded > 0) return

  const seenWorkspace = await page
    .locator('[data-testid="workspace-header"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-workspace-id")))
  const seenProject = await page
    .locator('[data-testid="project-header"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-project-id") ?? el.textContent?.trim() ?? null))
  throw new Error(
    `GATING: no project/workspace section to expand for ${JSON.stringify(candidates)} — ` +
      `projects=${JSON.stringify(seenProject)} workspaces=${JSON.stringify(seenWorkspace)}`,
  )
}

/** Opens the terminal creator and presses the "Shell" tile — same contract `core-terminal.spec.ts`'s `createPlainTerminal` pins against the mock. */
export async function createShellTerminal(page: Page) {
  await ensureRailPinnedOpen(page)
  const before = await page
    .locator('[data-testid="rail-sidebar-terminal-row"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-terminal-id")).filter((id): id is string => !!id))
  const newTermBtn = page.locator('[data-testid="workspace-scope-new-terminal"]')
  await expect(newTermBtn, 'the toolbar\'s "New Terminal" affordance never appeared').toBeVisible({ timeout: 15_000 })
  await newTermBtn.first().click()
  const launchers = page.locator('[data-component="terminal-new-launchers"]')
  await expect(launchers, "the terminal creator's launcher grid never opened").toBeVisible({ timeout: 15_000 })
  const shellTile = launchers.locator('[data-slot="terminal-launcher"][data-launcher-id="shell"]')
  await expect(shellTile, 'the creator\'s "Shell" tile never appeared').toBeVisible({ timeout: 10_000 })
  await shellTile.click()
  const deadline = Date.now() + 30_000
  for (;;) {
    const fromRail = await page
      .locator('[data-testid="rail-sidebar-terminal-row"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-terminal-id")))
    const railId = fromRail.find(
      (id): id is string => !!id && id !== "new" && !id.startsWith("pending-") && !before.includes(id),
    )
    if (railId) {
      const row = page.locator(`[data-testid="rail-sidebar-terminal-row"][data-terminal-id="${railId}"]`)
      const pane = page.locator(`[data-testid="terminal-pane"][data-terminal-id="${railId}"]`)
      if (await pane.isVisible().catch(() => false)) return railId
      if (await row.isVisible().catch(() => false)) await row.click()
      return railId
    }
    const paneId = await page
      .locator('[data-testid="terminal-pane"][data-terminal-id]:not([data-terminal-id^="pending-"])')
      .last()
      .getAttribute("data-terminal-id")
      .catch(() => null)
    if (paneId && !before.includes(paneId)) return paneId
    if (Date.now() > deadline) {
      throw new Error(
        `GATING: no new terminal row or pane appeared within 30000ms. Rows seen: ${JSON.stringify(fromRail)}`,
      )
    }
    await page.waitForTimeout(200)
  }
}

/** A scratch git worktree — same shape `desktop-unsigned-embedded.spec.ts`'s `makeScratchWorkspace` uses, kept here only for callers that need a real directory alongside the fixture's own (currently unused by either spec but kept available for a future scenario that needs a SECOND workspace). */
export async function makeScratchGitDir(label: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `claxedo-e2e-web-signed-${label}-`)))
  return dir
}

const execFileAsync = promisify(execFile)

/** Mirrors `real-harness-local.spec.ts`'s `resolveBinary` — resolves an override env var or a bare name on PATH, verified with `--version`. */
export async function resolveBinary(name: string, envVar: string): Promise<string | undefined> {
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

/**
 * Same asymmetry as `real-harness-local.spec.ts`'s `requireBinary`: an absent
 * binary is a contributor's local reality (visible `test.skip`) but a broken
 * CI job (loud GATING throw), because the lane is expected to install the
 * binaries it drives. Neither path is ever silent.
 */
export function requireBinary(binary: string | undefined, name: string, hint: string) {
  if (binary) return
  const reason =
    `${name} binary not found on PATH (or its override failed \`--version\`) — ${hint} ` +
    `No authentication is required for this tier: the scripted model server is the endpoint.`
  if (process.env.CI) throw new Error(`GATING: ${reason}`)
  test.skip(true, reason)
}

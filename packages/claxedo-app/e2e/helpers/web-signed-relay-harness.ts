import { stopChild as stopOwnedChild } from "./child-process"
/** Real signed relay fixture, production web build, and shared browser interaction helpers. */
import { expect, test, type Locator, type Page, type Request } from "@playwright/test"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { e2eAppViteEnvironment } from "../auth-mode"
import path from "node:path"
import { promisify } from "node:util"
import { SELECTORS as RAIL_SELECTORS } from "./rail-oracle"
import { claudeScriptedEnv, type ScriptedModelServer } from "./scripted-model-server"

export const APP_DIR = path.resolve(import.meta.dirname, "..", "..")
export const REPO_ROOT = path.resolve(APP_DIR, "..", "..")
export const SERVER_DIR = path.join(REPO_ROOT, "packages", "claxedo-server")

export type SignedRelayBacking = "cloud-vm" | "local-worktree"

/**
 * Mirrors `signed-browser-relay-fixture.mjs`'s stdout JSON shape — the exact
 * type both `real-cloud-relay.spec.ts` and `live-host-tunnel-relay.spec.ts`
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
  /**
   * The session the fixture registered through the real private-session
   * protocol (reserve -> register -> turn admission -> fenced snapshot).
   * Managed workspace-runtime routes are session-scoped, so PTY creation
   * needs this id rather than a literal restated by a spec.
   */
  sessionId: string
  runtimeAccessToken: string
  directory: string
  role: string
  controlPlaneToken: string
  browserUrl?: string
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

const stopChild = (child: ChildProcess | undefined) => stopOwnedChild(child, { processGroup: true })

export async function startSignedRelayFixture(opts: {
  backing: SignedRelayBacking
  backendPort: number
  scripted: ScriptedModelServer
  claudeConfigDir: string
  browserUrl?: string
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
        ...(opts.backing === "cloud-vm" ? { CLAXEDO_E2E_RELAY_FIXTURE_BACKING: "cloud-vm" } : {}),
        ...(opts.collaborativeOrg?.name
          ? { CLAXEDO_E2E_COLLABORATIVE_ORG_NAME: opts.collaborativeOrg.name }
          : {}),
        ...opts.scripted.piEnv,
        CLAXEDO_E2E_SCRIPTED_MODEL_URL: opts.scripted.v1Url,
        ...(opts.browserUrl ? { CLAXEDO_E2E_RELAY_PUBLIC_URL: opts.browserUrl } : {}),
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
        finish(new Error(`GATING: signed relay fixture (backing=${opts.backing}) did not start within 120s.\n${log}`))
      }, 120_000)
      child.stdout?.on("data", (chunk) => {
        const text = chunk.toString()
        log += text
        stdout += text
        for (const line of stdout.split("\n")) {
          if (settled || !line.trim()) continue
          try {
            const parsed = JSON.parse(line) as RelayFixtureInfo
            // Every field a consumer reads gates readiness: a fixture that
            // regresses and stops printing one would otherwise resolve with
            // `undefined` and fail 60s later inside a page gate instead of here.
            if (
              !parsed.backendUrl ||
              !parsed.relayUrl ||
              !parsed.workspaceId ||
              !parsed.sessionId ||
              !parsed.runtimeAccessToken ||
              !parsed.controlPlaneToken
            ) {
              continue
            }
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
            `GATING: signed relay fixture (backing=${opts.backing}) exited before starting (${code ?? signal}).\n${log}`,
          ),
        )
      })
      child.once("error", finish)
    })
  } catch (error) {
    await stopChild(child)
    throw error
  }

  const inventory = await fetch(`${info.relayUrl}/workspaces/${info.workspaceId}/session`, {
    headers: { authorization: `Bearer ${info.runtimeAccessToken}` },
    signal: AbortSignal.timeout(15_000),
  }).catch(async (error) => {
    await stopChild(child)
    throw error
  })
  if (!inventory.ok) {
    await stopChild(child)
    throw new Error(`Signed relay inventory failed: ${inventory.status} ${await inventory.text()}`)
  }

  return { info: { ...info, browserUrl: opts.browserUrl }, log: () => log, close: () => stopChild(child) }
}

export type RunningWebApp = {
  url: string
  close(): Promise<void>
}

/**
 * Builds the production web bundle against the same-origin fixture gateway.
 * Preview serves that exact artifact; the gateway transports the real signed
 * JWT and relay bearer tokens. This is not proof of BetterAuth cookie login.
 * Separate output directories keep lane builds isolated.
 */
export async function buildAndServeWebApp(opts: {
  backendUrl: string
  relayUrl: string
  outDir: string
  previewPort: number
}): Promise<RunningWebApp> {
  const url = `http://app.localhost:${opts.previewPort}`
  let buildLog = ""
  await new Promise<void>((resolve, reject) => {
    const build = spawn(
      "node",
      ["./node_modules/vite/bin/vite.js", "build", "--config", "vite.cloud.config.ts", "--outDir", opts.outDir],
      {
        cwd: APP_DIR,
        env: {
          ...process.env,
          // The one build-environment owner every e2e vite launcher reads
          // (`e2e/auth-mode.ts`): the adapter selection and the e2e-only seams
          // (test-auth bypass, the `/__e2e/*` routes) that stay alive in this
          // production bundle and are tree-shaken out of every other build.
          ...e2eAppViteEnvironment(),
          VITE_CLAXEDO_SERVER_URL: url,
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
      "./e2e/helpers/fixture-web-preview.mjs",
      opts.outDir,
      String(opts.previewPort),
      opts.backendUrl,
      opts.relayUrl,
    ],
    {
      cwd: APP_DIR,
      env: {
        ...process.env,
        ...e2eAppViteEnvironment(),
        VITE_CLAXEDO_SERVER_URL: url,
      },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    },
  )

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

    const healthy = await fetch(`http://127.0.0.1:${opts.previewPort}`, { signal: AbortSignal.timeout(3_000) })
      .then((r) => r.ok)
      .catch(() => false)
    if (!healthy) throw new Error(`GATING: child-owned vite preview at ${url} did not become healthy.\n${previewLog}`)
    for (const cookie of [undefined, "claxedo_fixture_jwt=invalid-signature"]) {
      const denied = await fetch(`http://127.0.0.1:${opts.previewPort}/api/control/session-registrations/reserve`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({ operationId: "op_auth_probe", sessionId: "ses_auth_probe", workspaceId: "ws_auth_probe", kind: "create" }),
        signal: AbortSignal.timeout(5_000),
      })
      if (denied.status !== 401) {
        throw new Error(`Signed gateway did not reject missing or invalid credentials with 401: ${denied.status} ${await denied.text()}`)
      }
    }
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
 * workspace). The placement is threaded through so ONE function serves both
 * lanes; the seeded rows carry the project inventory's own `kind` word, which
 * is what `rowHostKind` narrows in the page.
 */
export async function seedWorkspace(
  page: Page,
  info: RelayFixtureInfo,
  backing: SignedRelayBacking,
  authUser?: { id: string; fullName?: string },
) {
  const kind: "cloud" | "user-hosted" = backing === "cloud-vm" ? "cloud" : "user-hosted"
  if (info.browserUrl) {
    await page.context().addCookies([{
      name: "claxedo_fixture_jwt",
      value: info.controlPlaneToken,
      url: info.browserUrl,
      httpOnly: true,
      sameSite: "Lax",
    }])
  }
  await page.addInitScript(
    (seed: RelayFixtureInfo & {
      kind: "cloud" | "user-hosted"
      authUserId?: string
      authUserFullName?: string
    }) => {
      localStorage.clear()
      localStorage.setItem("claxedo.terminal.renderer", "dom")
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
        "claxedo.global.dat:server",
        JSON.stringify({
          list: [],
          projects: { local: [{ worktree: ref, expanded: true, sandboxes: [seed.workspaceId] }] },
          lastProject: {},
          workspaceServer: {},
          closedProjects: {},
        }),
      )
      localStorage.setItem(
        "claxedo.global.dat:globalSync.project",
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

/** The workspace-scoped draft route, or that workspace's route for one session. */
export function sessionRoute(info: RelayFixtureInfo, sessionId?: string) {
  const workspace = `/w/${encodeURIComponent(info.workspaceId)}/session`
  return sessionId ? `${workspace}/${encodeURIComponent(sessionId)}` : workspace
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
  for (const [index, line] of text.split("\n").entries()) {
    if (index) await input.press("Shift+Enter")
    await input.pressSequentially(line)
  }
  await expect(input).toContainText(text, { timeout: 10_000, useInnerText: true })
}

/**
 * Selects the real Pi harness and its OpenAI model, whose HTTP endpoint the
 * fixture redirects. Pi models are keyed under the `pi` harness namespace with
 * the provider folded into the model id, so the provider Pi routes to is the
 * prefix of `data-model`, not `data-provider`.
 */
export async function selectScriptedModel(page: Page) {
  await selectSignedHarness(page, "Pi", "pi")
  const control = page.locator('[data-action="prompt-harness-model"]:visible').last()
  await control.click()
  const picker = page.locator('[data-component="harness-model-picker"]')
  const search = picker.getByRole("textbox", { name: /Search models/i })
  await expect(search).toBeVisible({ timeout: 20_000 })
  await search.fill("GPT-4")
  await picker.locator('[data-slot="list-item"][data-key="pi:openai/gpt-4"]').click()
  await expect(control).toHaveAttribute("data-harness", "pi")
  await expect(control).toHaveAttribute("data-provider", "pi")
  await expect(control).toHaveAttribute("data-model", "openai/gpt-4")
}

export async function selectSignedHarness(page: Page, label: string, id: string) {
  const control = page.locator('[data-action="prompt-harness-model"]:visible').last()
  await expect(control).toBeEnabled({ timeout: 30_000 })
  await control.click()
  const picker = page.locator('[data-component="harness-model-picker"]')
  const section = picker.locator('[data-slot="harness-picker-section"]').first()
  if (await section.getAttribute("aria-expanded") !== "true") await section.click()
  await picker.getByRole("button", { name: label, exact: true }).click()
  await expect(control).toHaveAttribute("data-harness", id, { timeout: 30_000 })
  await page.keyboard.press("Escape")
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
  // means pinned (empty string), not the literal `"true"`. Treating `""` as falsy
  // reads a pinned rail as unpinned and clicks Hide Sidebar, collapsing it
  // mid-journey.
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

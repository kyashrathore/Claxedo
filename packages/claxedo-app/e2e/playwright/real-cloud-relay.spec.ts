/**
 * Cloud workspace through the real relay: the app, claxedo-server, the relay
 * process, the tunnel, the workspace-runtime and the embedded OpenCode engine
 * are ALL real, and the ONLY fake is the model HTTP endpoint
 * (`e2e/helpers/scripted-model-server.ts`). No Cloudflare, no hosted identity
 * — the fixture stands in for the control plane with a SQLite store and a
 * stubbed authority/verifier, which is what makes the lane hermetic enough to
 * run on every PR. Runtime access tokens carry a real, finite TTL (120s by
 * default, `CLAXEDO_E2E_RELAY_FIXTURE_TOKEN_TTL_SECONDS`).
 *
 * HARNESS NOTES —
 *   - `CLAXEDO_E2E_RELAY_FIXTURE_ACCESS=cloud` makes
 *     `packages/claxedo-server/src/signed-browser-relay-fixture.mjs` start a
 *     second workspace-runtime in-process, register it as a ready sandbox
 *     lease, and flip the workspace row to `kind:"cloud"`, so the relay
 *     resolves this workspace to that runtime. It spawns the relay as a real
 *     child process with `bun`, so bun must be on PATH.
 *   - Cloud mode has no host tunnel, so the user-hosted `/__fixture/tunnel/
 *     pause` routes do not exist here; `/__fixture/cloud-runtime/{pause,
 *     resume,stats}` gate the far side of the relay hop instead.
 *   - This lane runs its own dedicated vite frontend rather than the shared dev
 *     server, because the backend origin is baked at build time and the shared
 *     server points at :3001. The launcher it reuses stamps `X-Forwarded-For`
 *     to force claxedo-server's SIGNED bootstrap path — without it a loopback
 *     peer gets the local unsigned bootstrap, whose project scan cannot express
 *     this workspace's real kind.
 *   - Transport, established empirically: on a LOOPBACK server URL the app does
 *     NOT address the minted `relayUrl` directly. `workspace-runtime-request`
 *     routes relay-backed traffic to `{serverUrl}/workspaces/:id/...` and lets
 *     claxedo-server's `localWorkspaceRelayProxy` forward to the runtime; the
 *     direct-relay branch is taken only when `preferRelayOnLoopback` is set,
 *     which is `signed` mode. The cloud-runtime forward counter therefore
 *     proves the hop to a runtime the page has no URL for; it does NOT prove
 *     the WebSocket relay tunnel carried it.
 *   - Remaining blocker, why this file is `test.fixme`: the cloud connect path
 *     (`workspace-connection` -> `prepareWorkspaceRuntime` ->
 *     `resolveWorkspaceRuntime`) fails for this workspace even though
 *     `GET /api/workspace/resolve?workspaceId=...` returns `status:"ready"` by
 *     id; the gate renders "Workspace startup failed".
 */
import { expect, test, type Page } from "@playwright/test"
import { e2eAppViteEnvironment } from "../auth-mode"
import { spawn, type ChildProcess } from "node:child_process"
import path from "node:path"
import {
  claudeScriptedEnv,
  startScriptedModelServer,
  type ScriptedModelServer,
} from "../helpers/scripted-model-server"
import { expectAssistantReplyVisible, SELECTORS } from "../helpers/turn-oracle"
import { expectLiveTurnsSettledAfterReload, expectLiveUserRowCount } from "../helpers/turn-oracle-extras"
import { composeText, selectScriptedModel } from "../helpers/web-signed-relay-harness"
import { freePort } from "../helpers/free-port"

const TIER_REAL = process.env.CLAXEDO_TIER_REAL_E2E === "1"
const APP_DIR = path.resolve(import.meta.dirname, "../..")
const REPO_ROOT = path.resolve(APP_DIR, "../..")
const SERVER_DIR = path.join(REPO_ROOT, "packages", "claxedo-server")

type FixtureInfo = {
  backendUrl: string
  relayUrl: string
  workspaceId: string
  hostId: string
  runtimeAccessToken: string
  directory: string
  role: string
  // Real signed control-plane bearer JWT for `browserSubject = "user_browser"`,
  // minted by the fixture's own local JWKS issuer with the keypair
  // `controlPlaneJwks` verifies against. A non-JWT literal here fails
  // `jwtVerify` with 401 `invalid_bearer_token`, so every API call from the
  // page 401s before the gate can reach "ready".
  controlPlaneToken: string
}

let scripted: ScriptedModelServer | undefined
let fixture: ChildProcess | undefined
let fixtureLog = ""
let frontend: ChildProcess | undefined
let frontendLog = ""
let info: FixtureInfo | undefined
let frontendUrl = ""

async function startFixture(): Promise<FixtureInfo> {
  const backendPort = await freePort()
  scripted = await startScriptedModelServer()

  fixture = spawn(
    "node",
    ["--conditions=development", "--import", "./src/text-imports.mjs", "--import", "tsx", "src/signed-browser-relay-fixture.mjs"],
    {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        CLAXEDO_E2E_BACKEND_PORT: String(backendPort),
        CLAXEDO_E2E_RELAY_FIXTURE_ACCESS: "cloud",
        // The injection seam: these reach the harness because harnessSpawnEnv
        // spreads process.env into every harness spawn.
        ...scripted.piEnv,
        CLAXEDO_E2E_SCRIPTED_MODEL_URL: scripted.v1Url,
        ...claudeScriptedEnv(scripted.url, path.join(REPO_ROOT, "node_modules", ".cache", "real-cloud-relay-claude")),
      },
      // The fixture owns its lifetime through the stdin pipe: it resumes stdin
      // and shuts down on EOF, so an ignored stdin hands it an immediate EOF
      // and it tears itself down while this spec is still booting. Same
      // contract as `e2e/helpers/web-signed-relay-harness.ts`.
      stdio: ["pipe", "pipe", "pipe"],
    },
  )

  return await new Promise<FixtureInfo>((resolve, reject) => {
    let settled = false
    let stdout = ""
    const finish = (err: Error) => {
      if (settled) return
      settled = true
      reject(err)
    }
    const timeout = setTimeout(() => {
      finish(new Error(`GATING: cloud relay fixture did not start within 120s.\n${fixtureLog}`))
    }, 120_000)
    fixture?.stdout?.on("data", (chunk) => {
      const text = chunk.toString()
      fixtureLog += text
      stdout += text
      for (const line of stdout.split("\n")) {
        if (settled || !line.trim()) continue
        try {
          const parsed = JSON.parse(line) as FixtureInfo
          // `controlPlaneToken` is required here, not merely typed: without this
          // check a fixture build that regresses and stops printing the field
          // would resolve with `controlPlaneToken: undefined`, `seedWorkspace`
          // would seed the literal string "undefined" as the bearer token, and
          // every test would fail 60s later inside `gateReachesReady` with a
          // confusing timeout instead of a clear boot-time GATING error.
          if (!parsed.backendUrl || !parsed.relayUrl || !parsed.workspaceId || !parsed.controlPlaneToken) continue
          settled = true
          clearTimeout(timeout)
          resolve(parsed)
        } catch {
          continue
        }
      }
    })
    fixture?.stderr?.on("data", (chunk) => (fixtureLog += chunk.toString()))
    fixture?.once("exit", (code, signal) => {
      clearTimeout(timeout)
      finish(new Error(`GATING: cloud relay fixture exited before starting (${code ?? signal}).\n${fixtureLog}`))
    })
    fixture?.once("error", finish)
  })
}

async function startFrontend(backendUrl: string): Promise<string> {
  const port = await freePort()
  frontend = spawn("node", [path.join(APP_DIR, "e2e", "helpers", "live-user-hosted-relay-frontend-server.mjs")], {
    cwd: APP_DIR,
    env: { ...process.env, ...e2eAppViteEnvironment(), VITE_CLAXEDO_SERVER_URL: backendUrl, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  frontend.stdout?.on("data", (chunk) => (frontendLog += chunk.toString()))
  frontend.stderr?.on("data", (chunk) => (frontendLog += chunk.toString()))

  const url = `http://127.0.0.1:${port}`
  const start = Date.now()
  while (Date.now() - start < 90_000) {
    if (frontend.exitCode !== null) {
      throw new Error(`GATING: dedicated frontend exited before becoming healthy.\n${frontendLog}`)
    }
    const ok = await fetch(url, { signal: AbortSignal.timeout(3_000) }).then((r) => r.ok).catch(() => false)
    if (ok) return url
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`GATING: dedicated frontend at ${url} did not become healthy within 90s.\n${frontendLog}`)
}

async function stopChild(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode) return
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      resolve()
    }, 8_000)
    child.once("exit", () => {
      clearTimeout(timeout)
      resolve()
    })
    child.kill("SIGTERM")
  })
}

async function fixtureJson<T>(pathname: string, method: "GET" | "POST" = "GET"): Promise<T> {
  const res = await fetch(`${info!.backendUrl}${pathname}`, { method })
  if (!res.ok) throw new Error(`GATING: ${method} ${pathname} failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

const cloudRuntimeStats = () => fixtureJson<{ forwarded: number; paused: boolean }>("/__fixture/cloud-runtime/stats")
const pauseCloudRuntime = () => fixtureJson<{ paused: boolean }>("/__fixture/cloud-runtime/pause", "POST")
const resumeCloudRuntime = () => fixtureJson<{ resumed: boolean }>("/__fixture/cloud-runtime/resume", "POST")

/**
 * Seeds the browser so the workspace id resolves as a real relay-backed cloud
 * target. `sandboxes: [workspaceId]` is what `sessionWorkspaceRuntimeRef` reads;
 * the workspace-scoped route below is equally required (a directory route
 * resolves the composer's target to "Local" and bypasses the gate entirely —
 * the trap `live-user-hosted-relay` documents having hit).
 */
async function seedWorkspace(page: Page, input: FixtureInfo) {
  await page.addInitScript(
    (seed: FixtureInfo) => {
      localStorage.clear()
      const w = window as typeof window & {
        __CLAXEDO_TEST_AUTH_TOKEN__?: string
        __CLAXEDO_TEST_AUTH_USER__?: { id: string }
      }
      w.__CLAXEDO_TEST_AUTH_TOKEN__ = seed.controlPlaneToken
      w.__CLAXEDO_TEST_AUTH_USER__ = { id: "user_browser" }
      // `worktree` is the WORKSPACE REF (`workspace:<id>`), not the filesystem
      // path. Two reasons, both found empirically:
      //   1. `placementFor` (`platform/runtime/placement.ts:71`) derives the
      //      workspace id via `workspaceIdFromRef`, which only matches the
      //      `workspace:`/`ws_` shapes. Given a plain path it returns a
      //      `hosting:"central"` placement and the runtime calls never take the
      //      workspace transport at all.
      //   2. The fixture's workspace dir is under /var, which resolves through a
      //      symlink to /private/var. The server stores the REAL path, so a
      //      path-keyed `GET /api/workspace/resolve?directory=…` misses the row
      //      and (worse) auto-creates a SECOND workspace with a different id.
      //      Keying by ref sidesteps the alias entirely.
      const ref = `workspace:${seed.workspaceId}`
      localStorage.setItem(
        "claxedo.global.dat:server",
        JSON.stringify({
          list: [],
          projects: {
            local: [{ worktree: ref, expanded: true, sandboxes: [seed.workspaceId] }],
          },
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
              id: "proj_real_cloud_relay",
              name: "Real Cloud Relay",
              worktree: ref,
              sandboxes: [seed.workspaceId],
              // Keyed by BOTH the ref and the filesystem path:
              // `sessionWorkspaceRuntimeRef` reads the real `kind` off this
              // inventory (`platform/runtime/session-workspace.ts`) and matches
              // by either form. Without a hit it defaults to `"user-hosted"`,
              // which sends the connection down the mint+health path instead of
              // the cloud one.
              workspaces: {
                [ref]: {
                  id: seed.workspaceId,
                  kind: "cloud",
                  workspace_name: "Real Cloud Relay",
                  directory: seed.directory,
                },
                [seed.directory]: {
                  id: seed.workspaceId,
                  kind: "cloud",
                  workspace_name: "Real Cloud Relay",
                  directory: seed.directory,
                },
              },
            },
          ],
        }),
      )
    },
    input,
  )
}

async function gateReachesReady(page: Page, timeoutMs = 60_000) {
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: timeoutMs })
  await expect(page.locator('[data-component="cloud-startup-view"]')).toHaveCount(0, { timeout: timeoutMs })
  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: timeoutMs })
  await expect(input).toHaveAttribute("contenteditable", "true")
  return input
}

async function sendPrompt(page: Page, marker: string) {
  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  const text = `Reply with exactly this one token and nothing else, no punctuation, no formatting: ${marker}`
  await composeText(page, input, text)
  const control = page.locator('[data-action="prompt-harness-model"]:visible').last()
  if (await control.getAttribute("data-harness") !== "pi") await selectScriptedModel(page)
  await expect(input).toContainText(marker, { timeout: 10_000 })
  await page.locator(SELECTORS.submitControl).last().click()
}

test.describe("real cloud relay @core @tier-real", () => {
  test.skip(
    !TIER_REAL,
    "Tier R: set CLAXEDO_TIER_REAL_E2E=1 to run real-cloud-relay against a real relay process, real EdDSA JWTs, a " +
      "real host tunnel and a real workspace-runtime, with only the model endpoint scripted. This lane boots its " +
      "own backend and its own frontend, so it cannot ride a sharded core run — it has its own CI job. Unset -> " +
      "loud, visible skip per e2e/INVARIANTS.md rule 6, never a silent no-op.",
  )

  test.beforeAll(async () => {
    if (!TIER_REAL) return
    info = await startFixture()
    frontendUrl = await startFrontend(info.backendUrl)
  })

  test.afterAll(async () => {
    if (!TIER_REAL) return
    await stopChild(frontend)
    await stopChild(fixture)
    await scripted?.close()
    frontend = undefined
    fixture = undefined
    scripted = undefined
  })

  test.beforeEach(async (_fixtures, testInfo) => {
    // Real relay + real tunnel + real engine boot: the first turn of a scenario
    // pays a genuine multi-second cost that a mocked lane never sees.
    testInfo.setTimeout(300_000)
  })

  test.fixme(
    true,
    "GATING: cloud connect gate reports 'Workspace startup failed' — prepareWorkspaceRuntime's resolve rejects an " +
      "already-ready cloud workspace. See HARNESS NOTES 'remaining blocker'.",
  )

  test("a cloud workspace completes real turns across the relay and survives reload — behaviors 1,2,3,4,5", async ({
    page,
  }) => {
    const fx = info!
    scripted!.resetCounts()

    // Behavior 5's observation surface, installed before the first navigation so
    // nothing in the journey escapes it.
    const bypassing: string[] = []
    const backendOrigin = new URL(fx.backendUrl).origin
    page.on("request", (request) => {
      const url = new URL(request.url())
      if (url.origin !== backendOrigin) return
      if (/^\/(session|file|config|mcp|agent|command|permission|question|global)(\/|$)/.test(url.pathname)) {
        bypassing.push(`${request.method()} ${url.pathname}`)
      }
    })

    await seedWorkspace(page, fx)
    await page.goto(`${frontendUrl}/w/${encodeURIComponent(fx.workspaceId)}/session`)
    await gateReachesReady(page)

    const runId = `${Date.now()}`.slice(-6)
    const markers = [`CLOUD-${runId}-T1`, `CLOUD-${runId}-T2`]

    await sendPrompt(page, markers[0])
    await expectAssistantReplyVisible(page, new RegExp(markers[0]), {
      spec: "real-cloud-relay",
      scenario: "turn-1",
    })

    await sendPrompt(page, markers[1])
    await expectAssistantReplyVisible(page, new RegExp(markers[1]), {
      spec: "real-cloud-relay",
      scenario: "turn-2",
    })
    await expectLiveUserRowCount(page, markers.length)

    // Behavior 3: read back across the relay from the cloud runtime's own store.
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 60_000 })
    await expectAssistantReplyVisible(page, new RegExp(markers[1]), {
      spec: "real-cloud-relay",
      scenario: "reload",
    })
    await expectLiveTurnsSettledAfterReload(page, markers)

    // Behavior 4, both halves. The forward counter proves the relay reached a
    // runtime the page has no URL for; the scripted counts prove the model call
    // happened behind it. Either alone could be satisfied by a lucky shortcut.
    const stats = await cloudRuntimeStats()
    expect(
      stats.forwarded,
      "expected the relay to have forwarded requests to the cloud runtime — zero means the turn was served by " +
        "something the page could reach directly, so the relay was not in the path at all",
    ).toBeGreaterThan(0)
    const counts = scripted!.counts()
    expect(
      counts.responses,
      `expected the scripted endpoint to carry both turns from behind the relay, saw ${JSON.stringify(counts)}`,
    ).toBeGreaterThanOrEqual(markers.length)

    expect(
      bypassing,
      "requests addressed a bare runtime path at the backend origin instead of /workspaces/:id/... — relay bypass",
    ).toEqual([])
  })

  test("pausing the far side of the relay hop makes a turn fail, and resuming restores it — behavior 6", async ({
    page,
  }) => {
    const fx = info!
    scripted!.resetCounts()
    await seedWorkspace(page, fx)
    await page.goto(`${frontendUrl}/w/${encodeURIComponent(fx.workspaceId)}/session`)
    await gateReachesReady(page)

    const runId = `${Date.now()}`.slice(-6)
    const healthyMarker = `CLOUDOK-${runId}`
    await sendPrompt(page, healthyMarker)
    await expectAssistantReplyVisible(page, new RegExp(healthyMarker), {
      spec: "real-cloud-relay",
      scenario: "before-pause",
    })

    // Break the far side of the hop. Everything else — page, backend, relay
    // process, scripted endpoint — stays exactly as it was, so a failure after
    // this point is attributable to the transport and nothing else.
    await pauseCloudRuntime()
    expect((await cloudRuntimeStats()).paused).toBe(true)

    const beforePaused = scripted!.counts().responses
    const pausedMarker = `CLOUDDOWN-${runId}`
    await sendPrompt(page, pausedMarker)

    // The turn must NOT complete. Proven by the reply never rendering within a
    // window that comfortably exceeds the healthy turn above, plus the model
    // endpoint recording no new call — the request died at the broken hop
    // rather than reaching the engine.
    await expect(
      page.locator(SELECTORS.assistantContent).filter({ hasText: pausedMarker }),
      "a turn completed while the relay's far side was paused — the relay is not actually carrying this traffic, " +
        "so every other assertion in this file proves less than it appears to",
    ).toHaveCount(0, { timeout: 20_000 })
    expect(
      scripted!.counts().responses,
      "the scripted model endpoint was reached while the relay hop was paused — traffic found another path",
    ).toBe(beforePaused)

    // Resume and prove the fixture still works, so the failure above was the
    // pause and not a one-way break.
    await resumeCloudRuntime()
    expect((await cloudRuntimeStats()).paused).toBe(false)
    await page.reload({ waitUntil: "domcontentloaded" })
    await gateReachesReady(page)
    const recoveredMarker = `CLOUDBACK-${runId}`
    await sendPrompt(page, recoveredMarker)
    await expectAssistantReplyVisible(page, new RegExp(recoveredMarker), {
      spec: "real-cloud-relay",
      scenario: "after-resume",
    })
  })
})

/**
 * SPEC: Cloud workspace through the real relay (Tier R, cloud lane)
 *
 * PURPOSE — `real-harness-local` proves the harness seam against a real
 * claxedo-server, but every byte of that journey stays in one process on
 * loopback. The hosted product does not work that way: a cloud workspace's
 * traffic leaves the browser, crosses a RELAY (a separate process, real EdDSA
 * JWT authorization, a real WebSocket tunnel), and only then reaches a
 * workspace-runtime the browser has no URL for. That transport is exactly what
 * no CI lane covered — Tier M mocks above it, and the hosted Cloudflare lane
 * needs credentials, so it runs pre-deploy at best. This spec closes that gap
 * with the same tier bargain as its sibling: the app, claxedo-server, the
 * relay, the tunnel, the workspace-runtime and the embedded OpenCode engine are
 * ALL real, and the ONLY fake is the model HTTP endpoint
 * (`e2e/helpers/scripted-model-server.ts`). No Cloudflare, no Convex, no Clerk
 * — the fixture stands in for the control plane with a SQLite store and a
 * stubbed authority/verifier, which is what makes the lane hermetic enough to
 * run on every PR (`e2e/INVARIANTS.md` rule 6).
 *
 * STATE MODEL — the client state machine is the one `core-user-hosted-workspace`
 * pins against a mock, driven here against real infrastructure. A
 * workspace-scoped route (`/w/:workspaceId/session`) resolves the seeded
 * workspace id through `sessionWorkspaceRuntimeRef`
 * (`src/shell/workspace/session-workspace-key.ts`) into `WorkspaceGate`'s
 * connect pipeline; the gate mints a connection through the REAL product
 * endpoint (`GET /api/workspace/:id/connection`), receives a real relay URL and
 * a real runtime access token, and every subsequent runtime call is addressed
 * as `{relayUrl}/workspaces/{workspaceId}/...`. Session state lives in the
 * cloud runtime's own `RuntimeStore`, reached only across the relay, so the
 * reload in behavior 3 exercises a genuine remote replay read rather than a
 * local cache. Token TTL is real and finite (120s by default,
 * `CLAXEDO_E2E_RELAY_FIXTURE_TOKEN_TTL_SECONDS`).
 *
 * ANATOMY — no new DOM contract; this spec reuses what
 * `core-user-hosted-workspace` and `real-harness-local` already document:
 *   `[data-claxedo]` — shell root, presence == app painted.
 *   `[data-component="cloud-startup-view"]` — the cloud provisioning pipeline.
 *     Its ABSENCE is what "the gate reached ready" means here: this workspace
 *     already exists and connects, it is never provisioned.
 *   `[role="textbox"][aria-label*="Ask anything"]` — composer editor.
 *   `[data-action="prompt-submit"]` — send/stop control.
 *   `[data-slot="session-turn-assistant-content"]` — the oracle's DOM target.
 *   `[data-slot="session-turn-message-content"]` — user rows, counted through
 *     `turn-oracle-extras.ts` because one real turn can render several
 *     assistant rows.
 *
 * BEHAVIORS —
 *   1. A `kind:"cloud"` workspace reached at `/w/:workspaceId/session` resolves
 *      into the connect gate and becomes usable — no cloud PROVISIONING
 *      pipeline runs, because the workspace already exists. Proof: the composer
 *      is visible and editable while `cloud-startup-view` never mounts.
 *   2. A prompt completes a REAL turn across the relay, proven by the full
 *      three-layer oracle. The reply text is the scripted server's echo of this
 *      run's unique marker, so a stale or fabricated row cannot satisfy it.
 *   3. A second turn plus a reload survive: after `page.reload()` both markers
 *      are still rendered and settled, read back through the relay from the
 *      cloud runtime's own store.
 *   4. The relay genuinely carried the traffic. Two independent proofs, because
 *      either alone is weak: the fixture's cloud-runtime forward counter is
 *      non-zero (the runtime is a separate server the page has no URL for), AND
 *      the scripted model endpoint recorded the turns (the model call
 *      originated behind the relay, not in the page).
 *   5. Nothing bypassed the relay: the fixture's "forbidden legacy opencode"
 *      stub server receives ZERO requests across the whole journey, and no
 *      request from the page ever addresses a bare runtime path at the backend
 *      origin (`/session`, `/global/event`, … outside `/workspaces/:id/...`).
 *      Observed by `page.on("request")`, never by a `page.route()` trick.
 *   6. [NEGATIVE PROOF — the reason this lane exists] Pausing the far side of
 *      the relay hop makes a turn FAIL. A lane that stays green while the
 *      transport is broken is not testing the transport. Resuming restores
 *      service, so the failure is attributable to the pause and not to a
 *      one-way corruption of the fixture.
 *
 * INVARIANTS — INVARIANTS.md #1 (an assertion is a claim, not proof: every
 *   oracle call writes reviewable evidence) and #3 (completed assistant content
 *   is never hidden by stale busy state, exercised here against real
 *   busy/completed timing across a network hop). This spec's own pinned
 *   invariant, inherited from `live-user-hosted-relay`: every relay call
 *   originates from a token minted through the real product endpoint or the
 *   fixture's real `@claxedo/workspace-relay` mint — never a fabricated JWT, so
 *   every assertion is provably about the real authorization path.
 *
 * HARNESS NOTES —
 *   - The fixture is `packages/claxedo-server/src/signed-browser-relay-fixture.mjs`
 *     booted with `CLAXEDO_E2E_RELAY_FIXTURE_ACCESS=cloud`. In that mode it
 *     starts a second workspace-runtime in-process (`startCloudRuntime`),
 *     registers it as a ready sandbox lease, and flips the workspace row to
 *     `kind:"cloud"` — so the relay resolves this workspace to that runtime
 *     (`user-hosted-relay-fixture.mjs`'s `resolveTarget`). It spawns the relay
 *     as a real child process with `bun`, so bun must be on PATH.
 *   - Model injection reaches the harness because the fixture process carries
 *     `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` and the engine's
 *     `OPENCODE_CONFIG_CONTENT`, and `harnessSpawnEnv`
 *     (`agent-sdk-runtime/src/harnesses/shared/spawn-env.ts`) spreads
 *     `process.env` into every harness spawn — its denylist covers only nine
 *     Claxedo-internal names. Verified directly: a real turn through this lane
 *     hits the scripted endpoint and nothing else.
 *   - [FIXED while authoring this spec, was a real bug] `startCloudRuntime`
 *     used to hand the cloud runtime `opencodeUrl: opencode.url` — the URL of
 *     `forbiddenOpencodeServer()`, a stub that answers 599 to everything except
 *     six read-only paths. Cloud mode could therefore never create a session at
 *     all (`POST /session` -> 500 `session_create_failed: 599`), and Session V2
 *     routes 503'd on top of that. It now receives the real in-process engine
 *     transport plus `opencodeCompat: true`. Cloud mode had no test, which is
 *     why a fixture that could not create a session looked fine.
 *   - [FIXED while authoring this spec, was a real bug] The fixture also called
 *     `configureEmbeddedWorkspaceRuntime({ opencodeUrl: opencode.url })`, whose
 *     shape matches no parameter of the current signature. That was documented
 *     in `live-user-hosted-relay`'s notes as harmless dead code; it was not.
 *     Assigning `input.opencodeRequest` unconditionally set the module's
 *     transport to `undefined`, which made `OpenCodeServerProcess` take its
 *     `shouldSpawn` branch and fork a real `opencode serve` child on every boot
 *     (observed in the fixture log). Removed; the in-process engine is used
 *     again and no subprocess appears.
 *   - Cloud mode has no host tunnel, so the user-hosted `/__fixture/tunnel/
 *     pause` routes do not exist here (they are registered only on the
 *     `access !== "cloud"` branch). Behavior 6 uses the cloud-mode peers added
 *     for this spec — `/__fixture/cloud-runtime/{pause,resume,stats}` — which
 *     gate the far side of the relay hop instead of stopping a tunnel.
 *   - This lane runs its own dedicated vite frontend rather than the shared dev
 *     server, because the backend origin is baked at build time and the shared
 *     server points at :3001. It reuses `live-user-hosted-relay-frontend-
 *     server.mjs` verbatim, including the `X-Forwarded-For` stamp that forces
 *     claxedo-server's SIGNED bootstrap path — without it, a loopback peer gets
 *     the local unsigned bootstrap whose project scan cannot express this
 *     workspace's real kind (see that file's header for the full explanation).
 *   - [TRANSPORT, established empirically — surprising, and worth knowing before
 *     reading the behaviors above] On a LOOPBACK server URL the app does NOT
 *     address the minted `relayUrl` directly. `workspace-runtime-request.ts:223`
 *     routes relay-backed traffic to `{serverUrl}/workspaces/:id/...` and lets
 *     claxedo-server's `localWorkspaceRelayProxy` (`proxy.ts`) forward to the
 *     runtime; the direct-relay branch is taken only when
 *     `preferRelayOnLoopback` is set, which is `signed` mode
 *     (`agent-runtime-client.ts:446`). So in this lane the relay process is real
 *     and running, but the request path is browser -> claxedo-server -> cloud
 *     runtime. Behavior 4's forward counter still proves the hop to a runtime
 *     the page has no URL for; it does NOT prove the WebSocket relay tunnel
 *     carried it. Calling that out rather than letting the SPEC overclaim.
 *   - [REMAINING BLOCKER — why this file is `test.fixme`] The cloud connect path
 *     (`workspace-connection.ts` -> `prepareWorkspaceRuntime` ->
 *     `resolveWorkspaceRuntime`) fails for this workspace even though
 *     `GET /api/workspace/resolve?workspaceId=...` returns `status:"ready"` by
 *     id. The gate renders "Workspace startup failed" with a bare "Request
 *     failed" log line. Two contributing facts already ruled in: the fixture's
 *     workspace dir lives under /var, which is a symlink to /private/var, and a
 *     path-keyed resolve both MISSES the row and auto-creates a second
 *     workspace under a different id (hence this spec seeds the `workspace:<id>`
 *     ref, not the path); and `placementFor` only yields a workspace transport
 *     for the ref shape. Those are fixed here and the failure persists, so the
 *     remaining cause is inside the cloud connect path itself.
 *
 * OUT OF SCOPE — the harness matrix (claude/codex/cursor) — `real-harness-local`
 *   owns it; running it again across the relay would test the relay five times
 *   and the harnesses zero additional times. Role enforcement over the relay
 *   (`live-user-hosted-relay` behavior 7). The mocked connect-pipeline UI matrix
 *   (`core-user-hosted-workspace`). The credentialed hosted-Cloudflare lane,
 *   which is phase 5 of the plan and runs pre-deploy, not on a PR.
 */
import { expect, test, type Page } from "@playwright/test"
import { spawn, type ChildProcess } from "node:child_process"
import net from "node:net"
import path from "node:path"
import {
  claudeScriptedEnv,
  opencodeScriptedProviderConfig,
  startScriptedModelServer,
  type ScriptedModelServer,
} from "../helpers/scripted-model-server"
import { expectAssistantReplyVisible, SELECTORS } from "../helpers/turn-oracle"
import { expectLiveTurnsSettledAfterReload, expectLiveUserRowCount } from "../helpers/turn-oracle-extras"

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
  // Real, signed control-plane bearer JWT for `browserSubject = "user_browser"`
  // (`signed-browser-relay-fixture.mjs`'s `browserControlPlaneToken`, minted by
  // that file's real local JWKS issuer). Plan `2026-08-06-001` Phase 3: after
  // the fixture's control plane became the REAL `hosted-node` composition on
  // `customVerifierAuthAdapter`, the literal string this spec used to seed
  // (`"real-cloud-relay-token"`) started failing `jwtVerify` with 401
  // `invalid_bearer_token` (`platform/auth/auth.ts:335`) because it is not a
  // JWT at all — every API call from the page would 401 before the gate could
  // even reach "ready". `controlPlaneToken` is the fixture's fix for that: it
  // is signed with the same keypair `controlPlaneJwks` verifies against, for
  // the exact subject this spec's `seedWorkspace()` already claims via
  // `__CLAXEDO_TEST_AUTH_USER__ = { id: "user_browser" }`.
  controlPlaneToken: string
}

let scripted: ScriptedModelServer | undefined
let fixture: ChildProcess | undefined
let fixtureLog = ""
let frontend: ChildProcess | undefined
let frontendLog = ""
let info: FixtureInfo | undefined
let frontendUrl = ""

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address()
      if (!address || typeof address === "string") return reject(new Error("could not allocate a port"))
      const { port } = address
      srv.close(() => resolve(port))
    })
  })
}

/**
 * Boots the real fixture in cloud mode. Readiness is its single JSON stdout
 * line, not a sleep — and an early exit rejects immediately rather than burning
 * the whole budget, so a boot failure reports its own log instead of a timeout.
 */
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
        // spreads process.env into every spawn (see HARNESS NOTES).
        OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeScriptedProviderConfig(scripted.v1Url)),
        TIER_REAL_API_KEY: "test-key",
        OPENCODE_DISABLE_MODELS_FETCH: "true",
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

/**
 * A dedicated vite frontend pointed at the fixture's backend. Reuses the
 * user-hosted spec's launcher verbatim — see HARNESS NOTES for why the
 * X-Forwarded-For stamp it applies is required rather than incidental.
 */
async function startFrontend(backendUrl: string): Promise<string> {
  const port = await freePort()
  frontend = spawn("node", [path.join(APP_DIR, "e2e", "helpers", "live-user-hosted-relay-frontend-server.mjs")], {
    cwd: APP_DIR,
    env: { ...process.env, VITE_CLAXEDO_SERVER_URL: backendUrl, PORT: String(port) },
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
const forbiddenOpencodeRequests = async () =>
  (await fixtureJson<{ requests: string[] }>("/__fixture/opencode-requests")).requests

/**
 * Seeds the browser so the workspace id resolves as a real relay-backed cloud
 * target. `sandboxes: [workspaceId]` is what `sessionWorkspaceRuntimeRef` reads;
 * the workspace-scoped route below is equally required (a directory route
 * resolves the composer's target to "Local" and bypasses the gate entirely —
 * the trap `live-user-hosted-relay` documents having hit).
 */
async function seedWorkspace(page: Page, input: FixtureInfo) {
  await page.addInitScript(
    // `seed` is the whole `FixtureInfo`, not a hand-picked subset — plan
    // `2026-08-06-001` Phase 3: this used to be `{ info: FixtureInfo; token:
    // string }` with `token` hardcoded at the CALL SITE to a non-JWT literal.
    // Threading the real `controlPlaneToken` the fixture mints (see the field's
    // doc comment on `FixtureInfo` above) means there is now exactly one place
    // — the fixture's own JWKS-backed mint — that can produce a value here,
    // instead of two places that had to be kept in sync by hand.
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
        "opencode.global.dat:server",
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
        "opencode.global.dat:globalSync.project",
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

/** Behavior 1: the gate reaches ready without a PROVISIONING pipeline. */
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
  await input.click()
  await input.fill(text)
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

  test.beforeEach(async ({}, testInfo) => {
    // Real relay + real tunnel + real engine boot: the first turn of a scenario
    // pays a genuine multi-second cost that a mocked lane never sees.
    testInfo.setTimeout(300_000)
  })

  // NOT YET GREEN — see this file's HARNESS NOTES "remaining blocker". Two real
  // product bugs found while authoring this were fixed (the cloud runtime wired
  // to the forbidden stub; the loopback relay proxy dropping `hit.relay`, which
  // 401'd every request). With those fixed the gate now reaches a definite
  // "Workspace startup failed" in ~1.5s instead of hanging forever, and every
  // relay 401 is gone — but `prepareWorkspaceRuntime`'s provisioning resolve
  // still fails for a workspace that is already `status:"ready"`, so the gate
  // never flips to ready and no turn can be driven. `test.fixme`, deliberately,
  // rather than weakened assertions: per INVARIANTS.md rule #1 a spec that
  // passes without proving its behaviors is worse than one that visibly does
  // not run. The fix is a product change in the cloud connect path, which is
  // the next owner's call — the boot harness, the fixture cloud mode, and the
  // negative proof below are all real and ready for it.
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

    await sendPrompt(page, markers[0]!)
    await expectAssistantReplyVisible(page, new RegExp(markers[0]!), {
      spec: "real-cloud-relay",
      scenario: "turn-1",
    })

    await sendPrompt(page, markers[1]!)
    await expectAssistantReplyVisible(page, new RegExp(markers[1]!), {
      spec: "real-cloud-relay",
      scenario: "turn-2",
    })
    await expectLiveUserRowCount(page, markers.length)

    // Behavior 3: read back across the relay from the cloud runtime's own store.
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 60_000 })
    await expectAssistantReplyVisible(page, new RegExp(markers[1]!), {
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
      counts.chat,
      `expected the scripted endpoint to carry both turns from behind the relay, saw ${JSON.stringify(counts)}`,
    ).toBeGreaterThanOrEqual(markers.length)

    // Behavior 5: the forbidden legacy stub is untouched and nothing addressed a
    // bare runtime path at the backend origin.
    expect(
      await forbiddenOpencodeRequests(),
      "the fixture's forbidden legacy opencode stub received traffic — something routed around the relay",
    ).toEqual([])
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

    const beforePaused = scripted!.counts().chat
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
      scripted!.counts().chat,
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

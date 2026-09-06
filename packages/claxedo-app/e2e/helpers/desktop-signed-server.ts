/**
 * Shared harness for the Phase-4 `desktop-signed-*` lanes
 * (`desktop-signed-embedded-shared.spec.ts`, `real-desktop-signed-cloud.spec.ts`).
 *
 * WHY THIS FILE EXISTS — both signed lanes need the identical three-piece
 * boot sequence: spawn the REAL `hosted-node`-style control plane (Phase 3's
 * `signed-browser-relay-fixture.mjs`, real SQLite authority + real local
 * JWKS issuer, no stub), front it with a real non-loopback-marked reverse
 * proxy (see `startForwardedForProxy` below for why this is load-bearing,
 * not incidental), and point the PACKAGED app at that proxy's origin via
 * `defaultServerUrl` (see `electron-app.ts`'s `serverUrl` parameter doc for
 * why that env-var-free seam is the only one a `--dir` build honours). The
 * task's own instruction is explicit: "if you find yourself copying a
 * journey, extract it to a shared helper you also own" — this is that
 * extraction, written once so `real-desktop-signed-cloud.spec.ts` (F3, `access:
 * "cloud"`) and `desktop-signed-embedded-shared.spec.ts` (F1+F2, `access:
 * "user-hosted"`) differ ONLY in the `access` argument, never in the
 * plumbing around it.
 *
 * docs/plans/2026-08-06-001-test-full-matrix-real-e2e-plan.md, Phase 4.
 */
import { spawn, type ChildProcess } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { e2eAppViteEnvironment } from "../auth-mode"
import { freePort } from "./free-port"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR = path.resolve(HERE, "..", "..")
const REPO_ROOT = path.resolve(APP_DIR, "..", "..")
const SERVER_DIR = path.join(REPO_ROOT, "packages", "claxedo-server")

export type SignedFixtureAccess = "user-hosted" | "cloud"

export type SignedFixtureInfo = {
  backendUrl: string
  relayUrl: string
  workspaceId: string
  hostId: string
  runtimeAccessToken: string
  directory: string
  role: string
  /**
   * A real, signed control-plane bearer JWT for `browserSubject =
   * "user_browser"`, minted by the fixture's own local JWKS issuer
   * (`e2e-local-jwks-issuer.mjs`) — see `signed-browser-relay-fixture.mjs`'s
   * `browserControlPlaneToken` for the mint site. NOTE (found 2026-08-06,
   * see `desktop-signed-embedded-shared.spec.ts`'s file header): seeding this
   * into `window.__CLAXEDO_TEST_AUTH_TOKEN__` has NO EFFECT against the
   * CURRENT packaged desktop build — `testAuth()`
   * (`src/platform/auth/browser-auth-test-bypass.ts`) is gated on
   * `import.meta.env.DEV || MODE==="test" || VITE_CLAXEDO_E2E==="1"`, none of
   * which `packages/claxedo-desktop`'s `build:inner` (`electron-vite build`,
   * always production mode) ever sets — confirmed by extracting the shipped
   * `app.asar` and finding `function testAuth() { return {}; }`, i.e. the
   * ENTIRE bypass body was dead-code-eliminated. The field is threaded
   * through anyway so a future desktop build flavour that DOES bake
   * `VITE_CLAXEDO_E2E=1` can consume it with zero changes to this helper.
   */
  controlPlaneToken: string
  controlPlaneIssuer: string
  desktopRefreshToken: string
}

export async function stopChild(child: ChildProcess | undefined) {
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

/**
 * Spawns `signed-browser-relay-fixture.mjs` — the REAL `hosted-node` control
 * plane (`createSqliteCentralStore` + `createSqliteWorkspaceAuthority`
 * behind `customVerifierAuthAdapter`), a real local JWKS issuer, a real
 * `@claxedo/workspace-relay` child process, and (for `access: "cloud"`) a
 * second real in-process workspace-runtime standing in for the cloud
 * sandbox. Model injection is the ONE permitted fake (owner decision 1),
 * threaded exactly like `real-cloud-relay.spec.ts`'s `startFixture`, which
 * this mirrors — duplicated here rather than imported because that spec's
 * `startFixture` is a private, un-exported function local to its own file,
 * not a helper module.
 */
export async function startSignedFixture(input: {
  access: SignedFixtureAccess
  claudeScriptedEnv: (url: string, configDir: string) => Record<string, string>
  startScriptedModelServer: () => Promise<{ url: string; v1Url: string; piEnv: { PI_CODING_AGENT_DIR: string; OPENAI_API_KEY: string } }>
  logLabel: string
  hostHeartbeatDelayMs?: number
}): Promise<{
  info: SignedFixtureInfo
  scriptedModel: { url: string; v1Url: string; piEnv: { PI_CODING_AGENT_DIR: string; OPENAI_API_KEY: string } }
  log: () => string
  close: () => Promise<void>
}> {
  const backendPort = await freePort()
  const scriptedModel = await input.startScriptedModelServer()

  let log = ""
  const fixture = spawn(
    "node",
    // --conditions=development: the fixture's import chain reaches
    // `@claxedo/local-server/self-hosted-execution`, whose plain `import`
    // condition resolves to `dist/` — a BUILT artifact no e2e lane builds
    // (the desktop job's fresh runner died on exactly that
    // ERR_MODULE_NOT_FOUND). The `development` condition selects the TS
    // source, which the tsx loader executes; bun-run paths already do the
    // same via the export map's `bun` condition.
    ["--conditions=development", "--import", "./src/text-imports.mjs", "--import", "tsx", "src/signed-browser-relay-fixture.mjs"],
    {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        CLAXEDO_E2E_BACKEND_PORT: String(backendPort),
        CLAXEDO_E2E_RELAY_FIXTURE_ACCESS: input.access,
        CLAXEDO_E2E_HOST_HEARTBEAT_DELAY_MS: String(input.hostHeartbeatDelayMs ?? 0),
        ...scriptedModel.piEnv,
        CLAXEDO_E2E_SCRIPTED_MODEL_URL: scriptedModel.v1Url,
        ...input.claudeScriptedEnv(
          scriptedModel.url,
          path.join(REPO_ROOT, "node_modules", ".cache", `${input.logLabel}-claude`),
        ),
      },
      // The fixture deliberately owns its lifetime through stdin: keeping this
      // pipe open keeps the real backend alive, and an abrupt harness exit
      // closes it so the fixture can clean up. `/dev/null` reports EOF as soon
      // as the ready record is emitted and tears the backend down underneath
      // the proxy.
      stdio: ["pipe", "pipe", "pipe"],
    },
  )

  const info = await new Promise<SignedFixtureInfo>((resolve, reject) => {
    let settled = false
    let stdout = ""
    const finish = (err: Error) => {
      if (settled) return
      settled = true
      reject(err)
    }
    const timeout = setTimeout(() => {
      finish(new Error(`GATING: ${input.logLabel} fixture did not start within 120s.\n${log}`))
    }, 120_000)
    fixture.stdout?.on("data", (chunk) => {
      const text = chunk.toString()
      log += text
      stdout += text
      for (const line of stdout.split("\n")) {
        if (settled || !line.trim()) continue
        try {
          const parsed = JSON.parse(line) as SignedFixtureInfo
          if (!parsed.backendUrl || !parsed.relayUrl || !parsed.workspaceId || !parsed.controlPlaneToken) continue
          settled = true
          clearTimeout(timeout)
          resolve(parsed)
        } catch {
          continue
        }
      }
    })
    fixture.stderr?.on("data", (chunk) => (log += chunk.toString()))
    fixture.once("exit", (code, signal) => {
      clearTimeout(timeout)
      finish(new Error(`GATING: ${input.logLabel} fixture exited before starting (${code ?? signal}).\n${log}`))
    })
    fixture.once("error", finish)
  })

  return {
    info,
    scriptedModel,
    log: () => log,
    close: async () => {
      await stopChild(fixture)
    },
  }
}

/**
 * A pure API reverse proxy in front of the fixture's backend, stamping a
 * real non-loopback `X-Forwarded-For` on every request.
 *
 * WHY THIS IS REQUIRED, NOT OPTIONAL — `bootstrap.ts`'s
 * `isLoopbackLocalRequest` gate (`packages/claxedo-server-core/src/platform/http/
 * peer-address.ts`) takes the LOCAL bootstrap path for ANY request whose
 * real socket peer is loopback, and BOTH the fixture's backend (127.0.0.1)
 * and the packaged Electron app's outbound requests (from a desktop process
 * on the same machine) are loopback by construction — there is no way to
 * make this lane's traffic "not loopback" except by fronting it with a real
 * reverse proxy that stamps a non-loopback client IP, exactly the escape
 * hatch `isLoopbackLocalRequest`'s own comment documents ("a local reverse
 * proxy fronting external traffic"). Reuses
 * `live-user-hosted-relay-frontend-server.mjs` VERBATIM — that file already
 * implements this exact proxy (built for `live-user-hosted-relay.spec.ts`'s
 * web lane) using the real `vite.cloud.config.ts` proxy route table
 * (`/api`, `/session`, `/global`, `/pty`, … — the same paths a browser tab
 * would hit). The packaged desktop app never navigates to this server's HTML
 * (it loads from `file://`); only its `defaultServerUrl` points here, so
 * this process is consumed purely as an XFF-stamping API proxy. Not
 * reimplemented here as a bespoke proxy: hand-rolling WebSocket-upgrade
 * proxying (needed for `/pty`, `/event`) correctly is exactly the kind of
 * duplication the task's "extract, don't copy" instruction warns against —
 * one already-working implementation is reused instead of a second one that
 * could silently diverge.
 *
 * It is spawned with `e2eAppViteEnvironment()`, the single owner of the build
 * environment every e2e vite launcher passes: `vite.cloud.config.ts` refuses to
 * resolve a browser auth adapter implicitly, so a launcher without that
 * selection exits before it can listen.
 */
export async function startForwardedForProxy(backendUrl: string): Promise<{ url: string; close: () => Promise<void> }> {
  const port = await freePort()
  let log = ""
  const child = spawn(
    "node",
    [path.join(APP_DIR, "e2e", "helpers", "live-user-hosted-relay-frontend-server.mjs")],
    {
      cwd: APP_DIR,
      env: { ...process.env, ...e2eAppViteEnvironment(), VITE_CLAXEDO_SERVER_URL: backendUrl, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  child.stdout?.on("data", (chunk) => (log += chunk.toString()))
  child.stderr?.on("data", (chunk) => (log += chunk.toString()))

  const url = `http://127.0.0.1:${port}`
  const start = Date.now()
  while (Date.now() - start < 90_000) {
    if (child.exitCode !== null) {
      throw new Error(`GATING: X-Forwarded-For proxy exited before becoming healthy.\n${log}`)
    }
    const ok = await fetch(url, { signal: AbortSignal.timeout(3_000) }).then((r) => r.ok).catch(() => false)
    if (ok) break
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  if (Date.now() - start >= 90_000) {
    throw new Error(`GATING: X-Forwarded-For proxy at ${url} did not become healthy within 90s.\n${log}`)
  }

  return { url, close: () => stopChild(child) }
}

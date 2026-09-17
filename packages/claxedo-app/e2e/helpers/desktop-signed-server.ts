import { stopChild } from "./child-process"
export { stopChild } from "./child-process"
/**
 * Shared harness for the signed desktop lanes (`desktop-signed-embedded-shared.spec.ts`,
 * `real-desktop-signed-cloud.spec.ts`): spawn the real control-plane fixture
 * (`signed-browser-relay-fixture.mjs`), front it with an `X-Forwarded-For` reverse proxy
 * (`startForwardedForProxy`), and point the packaged app at the proxy via
 * `defaultServerUrl`. The two specs differ only in the `access` argument.
 */
import { spawn } from "node:child_process"
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
   * A signed control-plane bearer JWT for `browserSubject = "user_browser"`, minted by the
   * fixture's local JWKS issuer. Seeding it into `window.__CLAXEDO_TEST_AUTH_TOKEN__` has
   * no effect on a production desktop build: `testAuth()` is compiled out unless
   * `VITE_CLAXEDO_E2E=1` (or DEV/test mode) is baked in. Threaded through so a build
   * flavour that does bake it can consume it unchanged.
   */
  controlPlaneToken: string
  controlPlaneIssuer: string
  desktopRefreshToken: string
}


/**
 * Spawns `signed-browser-relay-fixture.mjs`: the real `hosted-node` control plane (SQLite
 * store and workspace authority behind `customVerifierAuthAdapter`), a local JWKS issuer,
 * a `@claxedo/workspace-relay` child, and for `access: "cloud"` a second in-process
 * workspace-runtime standing in for the cloud sandbox. Only the model endpoint is fake.
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
    // --conditions=development: the fixture imports `@claxedo/local-server/self-hosted-execution`,
    // whose default condition resolves to an unbuilt `dist/`; `development` selects the TS
    // source for the tsx loader.
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
 * An API reverse proxy in front of the fixture backend that stamps a non-loopback
 * `X-Forwarded-For` on every request. `isLoopbackLocalRequest` (`claxedo-server-core`
 * `peer-address.ts`) takes the local bootstrap path for any loopback peer, and both the
 * backend and the desktop app are loopback on one machine, so without the proxy the
 * signed path is never exercised. Reuses `live-user-hosted-relay-frontend-server.mjs`,
 * which already proxies the `vite.cloud.config.ts` route table including WebSocket
 * upgrades under `/api` (pty connects and the loopback `cp/events` socket); the
 * desktop app never loads its HTML.
 *
 * Spawned with `e2eAppViteEnvironment()`: `vite.cloud.config.ts` refuses to resolve a
 * browser auth adapter implicitly and exits before listening without it.
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

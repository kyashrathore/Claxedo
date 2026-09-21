import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { once } from "node:events"
import { serve } from "@hono/node-server"
import { createRemoteJWKSet, errors as joseErrors, exportJWK, exportPKCS8, exportSPKI, generateKeyPair, jwtVerify } from "jose"
import { mintHostTunnelToken, mintRuntimeAccessToken } from "@claxedo/workspace-relay"
import { createWorkspaceRuntimeApp } from "../../workspace-runtime/src/server.ts"
import { WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL } from "../../workspace-runtime/src/remote-session-authority.ts"
import { relayWorkspaceRuntimeExposure } from "../../workspace-runtime/src/exposure.ts"
import { configureEmbeddedWorkspaceRuntime } from "@claxedo/local-server/self-hosted-execution"
import { loadUserConfig, saveUserConfig } from "@claxedo/server-core/agent-config/index"
import { putCredential } from "@claxedo/server-core/credentials/registry"
import {
  createSelfHostedApp,
  embeddedManagedPrivateSessionPolicy,
} from "./deployments/self-hosted-node/app"
import { createControlPlaneServices } from "./authority/services.ts"
import { createSqliteCentralStore } from "./authority/adapters/sqlite/central-store.ts"
import { createSqliteWorkspaceAuthority } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority"
import { upsertUser, openAuthorityDb } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import { ControlPlaneAuthError, customVerifierAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import { startLocalJwksIssuer } from "./e2e-local-jwks-issuer.mjs"
import {
  configureWorkspaceSupervisor,
  createWorkspaceSupervisorSandboxManager,
  injectRuntime,
  shutdownWorkspaceSupervisor,
} from "./workspace/supervisor/index.ts"
import { createSupervisorSandboxLeaseStore } from "./sandbox/stores/sqlite-supervisor-state.ts"
import { ensureWorkspace } from "@claxedo/server-core/workspace/store/index"
import {
  startWorkspaceHostTunnel,
  stopAllWorkspaceHostTunnels,
  stopWorkspaceHostTunnel,
} from "./host-tunnel.ts"
import {
  hostEnrollmentPayload,
  localHostIdentity,
  signHostPayload,
} from "./workspace/local-host.ts"
import { createFixedWindowConnectionRateLimiter } from "./platform/auth/rate-limit.ts"
import { hostTunnelTokenSigner } from "@claxedo/server-core/platform/auth/runtime-access-token"
import { createSqliteHostTunnelTargetResolver } from "@claxedo/server-core/authority/adapters/sqlite/host-tunnel-relay-target"
import {
  connectFixtureRoutes,
  createConnectInstances,
  createFaults,
  provisionConnectRoots,
  relayHostPublicKeyFrom,
} from "./connect-host-fixture.mjs"

const execFileAsync = promisify(execFile)
const workspaceId = process.env.CLAXEDO_E2E_WORKSPACE_ID?.trim() || "ws_signed_browser_relay"
const projectId = "proj_signed_browser_relay"
const backing = process.env.CLAXEDO_E2E_RELAY_FIXTURE_BACKING === "cloud-vm" ? "cloud-vm" : "local-worktree"
// `embedded`: this process is the host (the desktop shape) and registers,
// assigns and beats for one workspace in-process. `connect`: no host in this
// process at all — the spec spawns real `claxedo connect` children through
// `/__fixture/connect/*`, the owner assigns folders through `claxedo host …`,
// and the relay child asks this control plane for targets, revocation and
// serving generations exactly as a deployed relay does.
const hostMode = process.env.CLAXEDO_E2E_RELAY_FIXTURE_HOST === "connect" ? "connect" : "embedded"
if (hostMode === "connect" && backing === "cloud-vm") throw new Error("connect host mode serves a local-worktree placement only")
const requestedRole = process.env.CLAXEDO_E2E_RELAY_FIXTURE_ROLE?.trim()
const role =
  requestedRole === "viewer" || requestedRole === "editor" || requestedRole === "owner" ? requestedRole : "editor"
const backendPort = Number(process.env.CLAXEDO_E2E_BACKEND_PORT || 0)
// The relay child dials the control plane's resolver routes by URL from the
// moment it starts, before this process has bound anything, so connect mode
// needs the port decided up front.
if (hostMode === "connect" && !backendPort) throw new Error("connect host mode needs CLAXEDO_E2E_BACKEND_PORT")
const scriptedModelUrl = process.env.CLAXEDO_E2E_SCRIPTED_MODEL_URL?.trim()
if (scriptedModelUrl && !process.env.PI_CODING_AGENT_DIR)
  throw new Error("Scripted Pi requires the provider fixture's native PI_CODING_AGENT_DIR")

function configureRuntimeSessionAuthorityUrl(controlPlaneUrl) {
  const normalized = controlPlaneUrl.replace(/\/+$/, "")
  if (!normalized || normalized.endsWith(":0")) return
  process.env[WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL] = `${normalized}/api/runtime-authority/session-authorize`
}
// Overridable so live-host-tunnel-relay.spec.ts's token-refresh scenario can
// force `tokenExpiresAt` inside `refreshWindowMs` (default 60s, see
// `src/utils/workspace-relay-connection.ts`'s `ensureFresh`) almost
// immediately after mint, without waiting out a real 120s TTL.
const tokenTtlSeconds = Number(process.env.CLAXEDO_E2E_RELAY_FIXTURE_TOKEN_TTL_SECONDS || 120)
const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-signed-browser-relay-"))
const dataDir = path.join(root, "data")
const workspaceDir = path.join(root, "workspace")
const desktopRefreshToken = "desktop_refresh_0"
let currentDesktopRefreshToken = desktopRefreshToken
let desktopRefreshes = 0
const desktopHostRequests = []
const hostHeartbeatDelayMs = Number(process.env.CLAXEDO_E2E_HOST_HEARTBEAT_DELAY_MS || 0)
const runtimeConfigToken = "signed-browser-relay-runtime-config"
let cloudRuntime
let localHostHeartbeatTimer
let localHostHeartbeatPromise = Promise.resolve()

process.env.CLAXEDO_DATA_DIR = dataDir
process.env.CLAXEDO_RELAY_JWT_ALG = "EdDSA"
process.env.WORKSPACE_RUNTIME_CONFIG_TOKEN = runtimeConfigToken
if (scriptedModelUrl) {
  // Scripted runs use only the fixture's encrypted credential store.
  delete process.env.CLAXEDO_CF_KV_URL
}
// The product has no implicit default harness: a fresh data dir leaves the
// embedded runtime with no runner, and every route that names no harness
// (`GET /command`, `GET /agent`) fails with `workspace_harness_not_configured`.
// This is the write `POST /api/claxedo/agent-config/harness` performs, made
// before the host tunnel below creates the embedded runtime that reads
// it. The control plane pushes no config snapshot to the cloud runtime this
// fixture hosts, so `startCloudRuntime` selects the same harness directly.
await saveUserConfig({ ...(await loadUserConfig()), defaultHarness: { kind: "native", harnessId: "pi" } })

// The relay host tunnel and the control plane's host enrollment are two views
// of the same machine identity. Use the product's canonical persisted identity
// for both; a fixture-only host id creates a live relay tunnel that
// `GET /api/workspace/:id/connection` correctly refuses as unregistered.
const fixtureLocalHostIdentity = backing === "cloud-vm" || hostMode === "connect" ? undefined : await localHostIdentity()
const hostId =
  fixtureLocalHostIdentity?.hostId ?? process.env.CLAXEDO_E2E_HOST_ID?.trim() ?? "host_signed_browser_relay"
const resolverToken = hostMode === "connect" ? `resolver_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}` : undefined

async function run(cwd, ...args) {
  await execFileAsync(args[0], args.slice(1), { cwd })
}

function attachHttpServerErrorHandlers(server) {
  server.on("clientError", (error, socket) => {
    if (error?.code === "ECONNRESET" || error?.code === "EPIPE") {
      socket.destroy()
      return
    }
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n")
  })
  server.on("connection", (socket) => {
    socket.setKeepAlive(false)
    socket.on("error", (error) => {
      if (error?.code === "ECONNRESET" || error?.code === "EPIPE") return
      console.error("signed-browser-relay-fixture: socket error", error)
    })
  })
}

async function closeHttp(server) {
  if (!server.listening) return
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    // Fixture teardown must not wait forever for an SSE connection whose
    // peer disappeared with the owning test process.
    server.closeAllConnections?.()
  })
}

async function serverPort(server, label) {
  if (!server.listening) await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error(`${label} did not bind`)
  return address.port
}

async function startCloudRuntime(input) {
  configureRuntimeSessionAuthorityUrl(input.controlPlaneUrl)
  const relayHostAuth = {
    key: input.relayHostPublicKey,
    workspaceId,
    // NOT `hostId` — for a cloud workspace the product's own host identity is
    // the WORKSPACE id, not this fixture's `host_*` name. `injectRuntime`
    // (`workspace-supervisor.ts:353`) is the direct-injection seam used below
    // and it documents this explicitly: "the workspace id is the synthetic host
    // identity here", setting `sandbox_target.hostId = ws.id`. That is what
    // `cloudConnectionInfo` reads (`workspace-cloud-connection.ts:63`) and mints
    // into every runtime access token the real app obtains from
    // `GET /api/workspace/:id/connection`. Pinning this runtime to `host_*`
    // instead made the relay reject the APP's own tokens with 403
    // `relay_token_host_mismatch` on every authenticated route (health passed,
    // since it is host-agnostic — which is exactly why this hid).
    hostId: workspaceId,
  }
  const runtime = createWorkspaceRuntimeApp({
    exposure: relayWorkspaceRuntimeExposure(relayHostAuth),
    target: {
      workspaceId,
      directory: workspaceDir,
    },
    relayHostAuth,
    configToken: runtimeConfigToken,
    harness: { kind: "native", harnessId: "pi" },
  })
  // The scripted endpoint is bound the way the control plane's config push
  // binds an account: as the `openai` provider projection. Pi takes a
  // projection as a `models.json` overlay onto its own openai provider, so
  // every openai model the picker offers reaches the scripted server. The
  // harness owns `models.json` in `PI_CODING_AGENT_DIR` and replaces it on
  // every config apply, so a base URL hand-written there never reaches a turn.
  if (scriptedModelUrl) {
    await runtime.host.apply({
      version: 4,
      mcp: {},
      connections: [],
      defaultHarness: { kind: "native", harnessId: "pi" },
      auth: {
        openai: {
          baseUrl: new URL(scriptedModelUrl).origin,
          apiPath: "/v1",
          placeholder: "test-key",
          authMode: "bearer",
        },
      },
    })
  }
  // Every request the relay forwards to this cloud runtime passes through here.
  // Two jobs, both for `real-cloud-relay.spec.ts`:
  //   1. COUNT — the spec asserts a real turn incremented this. The runtime is a
  //      separate HTTP server the browser has no URL for, so a non-zero count is
  //      positive proof the traffic genuinely crossed the relay hop rather than
  //      being served by anything the page could reach directly.
  //   2. PAUSE — cloud mode has no host tunnel to stop (that is the
  //      machine-placed shape), so `/__fixture/tunnel/pause` does not exist here. This gate is
  //      the cloud-mode equivalent: while paused the relay's forwarded request
  //      fails at the far end, which is what makes the "relay is load-bearing"
  //      negative proof possible in this lane at all.
  const stats = { forwarded: 0, paused: false }
  const server = serve({
    fetch: (request, ...rest) => {
      stats.forwarded += 1
      if (stats.paused) {
        return new Response(JSON.stringify({ error: { code: "cloud_runtime_paused" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        })
      }
      return runtime.app.fetch(request, ...rest)
    },
    port: 0,
    hostname: "127.0.0.1",
  })
  attachHttpServerErrorHandlers(server)
  runtime.injectWebSocket(server)
  const url = `http://127.0.0.1:${await serverPort(server, "Cloud runtime fixture")}`
  const health = await fetch(`${url}/api/wr/health`, {
    headers: {
      authorization: `Bearer ${runtimeConfigToken}`,
    },
  })
  if (!health.ok) throw new Error(`Cloud runtime fixture health failed: ${health.status}`)
  // The health probe above is this fixture's own, not the spec's traffic.
  stats.forwarded = 0
  return {
    url,
    stats,
    close: async () => {
      await closeHttp(server)
      await runtime.dispose()
    },
  }
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode) return
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      resolve()
    }, 3_000)
    child.once("exit", () => {
      clearTimeout(timeout)
      resolve()
    })
    child.kill("SIGTERM")
  })
}

// The relay admits browser WebSocket upgrades (PTY, event streams) only from
// its origin allowlist, whose default is loopback plus the product domains.
// A lane that serves the app from a front-door origin (`app.localhost:<port>`
// behind the preview proxy) names that origin here, the way a self-hosted
// deployment names its own with `CLAXEDO_RELAY_ALLOWED_ORIGINS`.
function relayAllowedOrigins() {
  const configured = process.env.CLAXEDO_RELAY_ALLOWED_ORIGINS?.trim()
  if (configured) return configured
  const publicUrl = process.env.CLAXEDO_E2E_RELAY_PUBLIC_URL?.trim()
  if (!publicUrl) return undefined
  return ["http://localhost:*", "http://127.0.0.1:*", new URL(publicUrl).origin].join(",")
}

async function startRelayFixture(input) {
  const logs = []
  const allowedOrigins = relayAllowedOrigins()
  const child = spawn("bun", ["src/host-tunnel-relay-fixture.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(allowedOrigins ? { CLAXEDO_RELAY_ALLOWED_ORIGINS: allowedOrigins } : {}),
      CLAXEDO_RELAY_FIXTURE_WORKSPACE_ID: workspaceId,
      CLAXEDO_RELAY_FIXTURE_HOST_ID: hostId,
      CLAXEDO_RELAY_FIXTURE_RUNTIME_PUBLIC_KEY_JWK: JSON.stringify(input.runtimePublicKeyJwk),
      CLAXEDO_RELAY_FIXTURE_HOST_PRIVATE_KEY_JWK: JSON.stringify(input.relayHostPrivateKeyJwk),
      ...(hostMode === "connect"
        ? {
            CLAXEDO_RELAY_FIXTURE_MODE: "connect",
            CLAXEDO_RELAY_RESOLVER_URL: `${input.controlPlaneUrl}/internal/relay`,
            CLAXEDO_RELAY_RESOLVER_TOKEN: resolverToken,
          }
        : {}),
    },
    // EOF is the child-owned parent-death signal. If this fixture is killed
    // before its JS shutdown handler can run, the relay still tears itself
    // down instead of surviving as a PID-1 orphan.
    stdio: ["pipe", "pipe", "pipe"],
  })

  return await new Promise((resolve, reject) => {
    let settled = false
    let stdout = ""
    const fail = (err) => {
      if (settled) return
      settled = true
      // `stopChild` resolves on exit or after a SIGKILL deadline; it never rejects.
      void stopChild(child).finally(() => reject(err))
    }
    const timeout = setTimeout(() => {
      fail(new Error(`Workspace Relay fixture did not start\n${logs.join("")}`))
    }, 10_000)

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString()
      logs.push(text)
      stdout += text
      for (const line of stdout.split("\n")) {
        if (settled || !line.trim()) continue
        try {
          const parsed = JSON.parse(line)
          if (!parsed.url) continue
          settled = true
          clearTimeout(timeout)
          resolve({
            url: parsed.url.replace(/\/$/, ""),
            close: () => stopChild(child),
          })
        } catch {
          continue
        }
      }
    })
    child.stderr?.on("data", (chunk) => {
      logs.push(chunk.toString())
    })
    child.once("exit", (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new Error(`Workspace Relay fixture exited before start (${code ?? signal})\n${logs.join("")}`))
    })
    child.once("error", fail)
  })
}

await fs.mkdir(workspaceDir, { recursive: true })
await run(workspaceDir, "git", "init", "-b", "main")
await fs.writeFile(path.join(workspaceDir, "hello.txt"), "hello through signed browser relay\n")
await run(workspaceDir, "git", "add", "hello.txt")
await run(
  workspaceDir,
  "git",
  "-c",
  "user.email=fixture@example.test",
  "-c",
  "user.name=Relay Fixture",
  "commit",
  "-m",
  "initial",
)
await fs.appendFile(path.join(workspaceDir, "hello.txt"), "relay diff line\n")

const runtime = await generateKeyPair("EdDSA", { extractable: true })
const relayHost = await generateKeyPair("EdDSA", { extractable: true })
process.env.CLAXEDO_RELAY_HOST_PUBLIC_KEY_JWK = JSON.stringify(await exportJWK(relayHost.publicKey))
// PTY connect authorizeStream mints a short stream lease with this key
// (`runtime-session-authority.ts` streamLeaseMinter). Without it, cloud WS
// opens then refreshAuthorization fails → closeDenied → double
// `client disconnected` before firstByte (blank xterm / cloud D).
process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM = await exportPKCS8(runtime.privateKey)
process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = await exportSPKI(runtime.publicKey)
process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM = "EdDSA"

const backendUrl = `http://127.0.0.1:${backendPort || 0}`
const relayHostPrivateKeyJwk = await exportJWK(relayHost.privateKey)
const relay = await startRelayFixture({
  runtimePublicKeyJwk: await exportJWK(runtime.publicKey),
  relayHostPrivateKeyJwk,
  controlPlaneUrl: backendUrl,
})
const relayUrl = relay.url
const publicRelayUrl = process.env.CLAXEDO_E2E_RELAY_PUBLIC_URL?.trim() || relayUrl
if (backendPort) configureRuntimeSessionAuthorityUrl(backendUrl)
if (hostMode === "connect") {
  // What a `claxedo connect` host is told on redeem and on every beat, read by
  // the enrollment routes through `hostConnectEndpointOptions(process.env)`
  // the same way the hosted and self-host compositions read it.
  process.env.CLAXEDO_RELAY_HOST_JWKS_URL = `${relayUrl}/.well-known/jwks.json`
  process.env.CLAXEDO_SESSION_AUTHORITY_URL = `${backendUrl}/api/runtime-authority/session-authorize`
}
configureWorkspaceSupervisor({
  server_url: backendUrl,
})

// --- Real control-plane auth + authority ----------------------------------
//
// The only thing this fixture stubs is the harness-called AI endpoint. Auth
// and authority are the code every real deployment runs:
//   - `startLocalJwksIssuer()` (`./e2e-local-jwks-issuer.mjs`) serves a real
//     HTTP JWKS endpoint backed by a real EdDSA keypair.
//   - `controlPlaneVerifier` below does `jose.jwtVerify()` against it — the
//     same shape `tokenVerifier`/`betterAuthAdapter` use in production
//     (`platform/auth/auth.ts`), pointed at this issuer.
//   - `customVerifierAuthAdapter` wires the two into `services.auth`; it is
//     the first-class adapter a self-hoster uses for Auth0/Ory/any OIDC issuer.
//   - `createSqliteWorkspaceAuthority()` is the same self-host
//     `WorkspaceAuthority` `createDefaultLocalControlPlaneServices` composes
//     without `CLAXEDO_WORKSPACE_AUTHORITY_URL`, backed by a SQLite file under
//     this fixture's own `CLAXEDO_DATA_DIR`, so it is deleted with the
//     `mkdtemp` root.
//
// Limit: a local JWKS issuer is a supported self-host mode, not a stub, but
// provider-specific behaviour (token shape, JWKS rotation cadence,
// session-claim vocabulary) is covered only by the nightly credentialed
// `live-*` lane. This proves the control plane's own auth/authority code
// against a real signed token, not the identity provider's wire format.
const jwksIssuer = await startLocalJwksIssuer()
const controlPlaneAudience = "claxedo-e2e-relay-fixture"
const controlPlaneJwks = createRemoteJWKSet(new URL(jwksIssuer.jwksUrl))
const controlPlaneVerifier = async (token, config) => {
  const { payload } = await jwtVerify(token, controlPlaneJwks, {
    issuer: config.issuer,
    ...(config.audience ? { audience: config.audience } : {}),
  }).catch((error) => {
    if (error instanceof joseErrors.JWTInvalid || error instanceof joseErrors.JWSInvalid
      || error instanceof joseErrors.JWTClaimValidationFailed || error instanceof joseErrors.JWTExpired
      || error instanceof joseErrors.JWSSignatureVerificationFailed) {
      throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Bearer token is invalid")
    }
    throw error
  })
  const subject = typeof payload.sub === "string" ? payload.sub : undefined
  if (!subject) throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Bearer token is missing a subject claim")
  return {
    mode: "signed",
    user: {
      subject,
      tokenIdentifier: `${config.issuer}|${subject}`,
      issuer: config.issuer,
      ...(typeof payload.org_id === "string" && payload.org_id ? { orgId: payload.org_id } : {}),
    },
  }
}

// The synthetic browser identity. `tokenIdentifier` MUST be built the exact
// same way `controlPlaneVerifier` builds it above (`${issuer}|${subject}`) —
// that string is the authority's row-ownership key
// (`workspace-authority-store.ts`'s `users` table primary key), so a request
// verified through the real path resolves to the SAME row this fixture seeds
// through the direct authority calls below.
const browserSubject = "user_browser"
const browserAuth = {
  mode: "signed",
  token: "",
  user: {
    subject: browserSubject,
    tokenIdentifier: `${jwksIssuer.issuer}|${browserSubject}`,
    issuer: jwksIssuer.issuer,
  },
}
if (scriptedModelUrl) {
  await putCredential(
    { provider_id: "openai", kind: "api_key", source: "local_only", secret: "test-key" },
    browserAuth.user.subject,
  )
}
// Printed in the stdout JSON as `controlPlaneToken`. A spec must send this as
// its bearer: a hardcoded non-JWT literal is rejected by `controlPlaneVerifier`
// with 401 `invalid_bearer_token`.
const browserControlPlaneToken = await jwksIssuer.mint({
  subject: browserSubject,
  audience: controlPlaneAudience,
  ttlSeconds: 3600,
})

const authority = createSqliteWorkspaceAuthority()
/**
 * The session-access composition this fixture's embedded workspace runtimes
 * are built with, composed ONCE here so the two places that need it cannot
 * disagree: `configureEmbeddedWorkspaceRuntime` below mounts this very object
 * on every runtime, and the host heartbeat declares its `sessionAuthority`
 * marker to the control plane.
 *
 * Declaring it is not decoration. The control plane mints a client's
 * event-stream scope from what the HOST says and infers nothing, so a fixture
 * that beat without this would publish an undeclared machine — the app would
 * open no workspace stream at all, exactly as a real host that never declared.
 * And this composition is `managed-private`, which serves session-scoped
 * streams ONLY: a fixture that declared "local" instead would send the app to
 * the workspace-wide stream this runtime answers with a permanent 400
 * `session_event_scope_required`.
 */
const embeddedSessionPolicy = embeddedManagedPrivateSessionPolicy(authority)
// Org→Team multiplayer e2e: personal orgs reject team CRUD. When
// `CLAXEDO_E2E_COLLABORATIVE_ORG_NAME` is set, create an application org with a
// default team and attach the fixture workspace to that org (D17).
const collaborativeOrgName = process.env.CLAXEDO_E2E_COLLABORATIVE_ORG_NAME?.trim() || ""
await authority.usersMe(browserAuth)
// The org every token and row below names is the authority's own for this
// user: `POST /api/workspace/cloud` stamps the local row with
// `authority.resolveOrgId(auth)` (`workspace/routes/index.ts`), and
// `workspaceForPull` (`authority/http/session-pull.ts`) refuses a session
// register/checkpoint with 409 `workspace_tenant_conflict` when the local row's
// `org_id` differs from the authority's workspace record.
let fixtureOrgId = await authority.resolveOrgId(browserAuth)
let fixtureDefaultTeamId
if (collaborativeOrgName) {
  const org = await authority.createOrg(browserAuth, { name: collaborativeOrgName })
  fixtureOrgId = org.org_id
  fixtureDefaultTeamId = org.default_team_id
}
const collaborativeOrgArgs = collaborativeOrgName ? { orgId: fixtureOrgId } : {}
// Connect mode has no fixed workspace: rows are cold-registered by the owner's
// `claxedo host assign`, and the directories live under the provisioned roots.
const connectRoots = hostMode === "connect" ? await provisionConnectRoots(path.join(root, "hosts")) : undefined
const workspace = hostMode === "connect" ? undefined : await ensureWorkspace({
  workspaceId,
  project_id: projectId,
  directory: workspaceDir,
  kind: "local",
  workspace_name: "Signed Browser Relay",
  // Cloud mode needs this on the row for the loopback relay proxy to mint a
  // runtime access token (`runtime-dispatch/internals.ts`'s `ensureCloudRuntime`
  // gates on `relayProvider && ws.org_id`).
  ...(backing === "cloud-vm" ? { org_id: fixtureOrgId } : {}),
})
if (!workspace && hostMode === "embedded") throw new Error("Signed browser relay workspace was not stored")

let effectiveWorkspace = workspace
if (hostMode === "connect") {
  // Nothing to register: the host, its enrollment and its assignments are all
  // created by the spec through the real CLI against the routes below.
} else if (backing === "cloud-vm") {
  cloudRuntime = await startCloudRuntime({
    relayHostPublicKey: relayHost.publicKey,
    controlPlaneUrl: backendUrl,
  })
  // Through `ensureWorkspace` rather than `updateWorkspace`: the store refuses
  // a cloud row with no driver, and `updateWorkspace`'s patch carries neither
  // `kind` nor `driver`, so the untyped `.mjs` call would have written the one
  // shape the store exists to reject.
  const cloudWorkspace = await ensureWorkspace({
    workspaceId,
    directory: workspaceDir,
    kind: "cloud",
    driver: "cloudflare",
    status: "ready",
  })
  effectiveWorkspace = cloudWorkspace ?? workspace
  // The lease the way provisioning makes one: acquire the generation, then
  // record the target. Identity reaches a lease through `recordTarget` alone.
  const fixtureLeaseStore = createSupervisorSandboxLeaseStore()
  const fixtureLease = await fixtureLeaseStore.acquire(workspaceId, {
    homeRegion: "us-east",
    driver: "cloudflare",
    staleAfterMs: 60_000,
  })
  await fixtureLeaseStore.recordTarget(workspaceId, fixtureLease.lease.epoch, {
    sandboxId: hostId,
    url: cloudRuntime.url,
    hostId,
    driverResourceId: hostId,
    labels: { app: "claxedo", workspaceId, epoch: String(fixtureLease.lease.epoch) },
  })
  injectRuntime(effectiveWorkspace, cloudRuntime.url)
  await authority.createCloudWorkspace(browserAuth, {
    workspaceId,
    projectId,
    displayName: "Signed Cloud Relay",
    repoName: "claxedo",
    gitBranch: "main",
    ...collaborativeOrgArgs,
  })
} else {
  if (!fixtureLocalHostIdentity) throw new Error("Host-tunnel fixture identity was not initialized")
  await authority.registerLocalForSharing(browserAuth, {
    workspaceId,
    projectId,
    displayName: "Signed Browser Relay",
    // Real filesystem directory the embedded workspace-runtime actually
    // serves. The signed bootstrap inventory projects `remote_directory`, and
    // the client's `sessionWorkspaceRuntimeRef` match needs it to agree with
    // the directory on disk. NOTE:
    // `createCloudWorkspace` (used above for `backing === "cloud-vm"`) has NO
    // `remoteDirectory` parameter on the real `WorkspaceAuthority` port
    // (`platform/auth/authority.ts:158-172`) — this is a genuine gap in the
    // real port, not something this fixture can route around; cloud-mode
    // routing already gets its directory from the SEPARATE `workspace/store`
    // row (`ensureWorkspace`, above), which is unaffected.
    remoteDirectory: workspaceDir,
    repoName: "claxedo",
    gitBranch: "main",
    ...collaborativeOrgArgs,
  })

  // Starting the relay tunnel above proves transport availability, while the
  // machine-wide enrollment + owner assignment + machine beat is the
  // authoritative control-plane presence record used to mint browser
  // connection credentials. Run it through the real SQLite authority with the
  // same enroll/assign/acquire/beat contract as the public routes, so terminal
  // and runtime-event clients exercise the production flow: routable = owner-
  // assigned AND acked at the owner's current revision AND live lease.
  const enrollmentRequest = await authority.createHostEnrollmentRequest(browserAuth, { hostId })
  const hostEnrollment = await authority.enrollHost(browserAuth, {
    hostId,
    publicKey: fixtureLocalHostIdentity.publicKey,
    requestId: enrollmentRequest.request_id,
    signature: signHostPayload(
      fixtureLocalHostIdentity,
      hostEnrollmentPayload({
        hostId,
        requestId: enrollmentRequest.request_id,
        nonce: enrollmentRequest.nonce,
      }),
    ),
    displayName: "Signed Browser Relay Host",
  })
  await authority.assignWorkspaceHost(browserAuth, { workspaceId, hostId, remoteDirectory: workspaceDir })
  // The machine caller the verifier builds for a signed request. This fixture
  // holds the authority in its own process, so there is no wire to sign
  // across; the row is read fresh per beat because the key version and serving
  // generation on it are what every write re-asserts.
  const machineCaller = async () => {
    const row = await authority.machineAuth.lookupEnrollment(hostEnrollment.enrollment_id)
    if (!row) throw new Error("signed-browser-relay-fixture: the host enrollment is gone")
    return {
      enrollmentId: row.enrollment_id,
      hostId: row.host_id,
      ownerUserId: row.owner_user_id,
      ownerActorId: row.owner_actor_id,
      scope: row.scope,
      keyVersion: row.key_version,
      generation: row.serving_generation,
    }
  }
  const { generation } = await authority.acquireHostServingGeneration(await machineCaller())
  const beatHostEnrollment = async () => {
    const declared = (await authority.listHostEnrollments(browserAuth))
      .find((row) => row.host_id === hostId)?.assignments ?? []
    return await authority.heartbeatHostEnrollmentByMachine(await machineCaller(), {
      enrollmentId: hostEnrollment.enrollment_id,
      hostId,
      generation,
      ttlMs: 60_000,
      // Read off the policy this machine's runtimes actually mount, never a
      // literal — the whole point of the declaration is that it comes from the
      // composition.
      sessionAuthority: embeddedSessionPolicy.sessionAuthority,
      // Only an ack at the revision the owner currently describes makes the
      // workspace routable, so the revision is read back rather than assumed.
      acks: declared
        .filter((assignment) => assignment.workspace_id === workspaceId)
        .map((assignment) => ({ workspaceId: assignment.workspace_id, revision: assignment.revision })),
    })
  }
  // The first beat acks the described set so the assignment is routable before
  // any spec asks for a connection.
  await beatHostEnrollment()

  // The full browser matrix intentionally keeps one fixture alive across many
  // fresh documents. Renew the real signed lease just as the desktop host
  // does; otherwise the default 60s lease expires halfway through the suite
  // and later connection requests correctly fail with 409.
  localHostHeartbeatTimer = setInterval(() => {
    localHostHeartbeatPromise = localHostHeartbeatPromise
      .then(beatHostEnrollment)
      .catch((error) => {
        console.error("signed-browser-relay-fixture: host enrollment heartbeat failed", error)
      })
  }, 15_000)
}
if (collaborativeOrgName && fixtureDefaultTeamId) {
  await authority.ensureDefaultTeam(browserAuth, { orgId: fixtureOrgId })
}
// Real display names for multiuser proof / attribution: the authority upsert
 // path does not take a name from the JWT, so stamp the owner before usersMe
 // caches actor_name for runtime token minting.
const authorityDb = openAuthorityDb()
const ownerDisplayName = process.env.CLAXEDO_E2E_OWNER_DISPLAY_NAME?.trim() || "Alice"
const ownerAvatarUrl = process.env.CLAXEDO_E2E_OWNER_AVATAR_URL?.trim() ||
  "data:image/svg+xml," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><circle cx="32" cy="32" r="32" fill="#2563eb"/><text x="32" y="33" dy=".35em" text-anchor="middle" fill="#fff" font-size="28" font-family="ui-sans-serif,system-ui,sans-serif" font-weight="700">A</text></svg>`,
  )
upsertUser(authorityDb(), {
  token_identifier: browserAuth.user.tokenIdentifier,
  subject: browserSubject,
  issuer: jwksIssuer.issuer,
  name: ownerDisplayName,
  image_url: ownerAvatarUrl,
  kind: "human",
})
const browserActor = await authority.usersMe(browserAuth)
const withRuntimeActor = (input) => {
  // Profile fields default to the browser owner's only when the token is
  // minted for that actor. Another actor's missing avatar stays missing; a
  // teammate's message must never render under Alice's picture.
  const own = !input.actorId || input.actorId === browserActor.actor_id
  const profile = own ? browserActor : {}
  const actorKind = input.actorKind ?? profile.actor_kind
  return {
    ...input,
    // `principal_kind` is a required Runtime Access Token claim: the relay
    // drops any token without it (`workspace-relay/src/auth.ts`'s
    // `runtimeClaims` -> 401 `relay_token_claims_invalid`) and additionally
    // requires it to agree with `actor_kind` — a human actor is a "user"
    // principal, an agent actor is a "service" principal. The production
    // signer input carries it as a required field
    // (`platform/auth/runtime-access-token.ts`'s
    // `RuntimeAccessTokenSignerInput`), so every mint in this fixture goes
    // through this one place to get it.
    principalKind: input.principalKind ?? (actorKind === "agent" ? "service" : "user"),
    actorId: input.actorId ?? browserActor.actor_id,
    actorKind,
    actorPublicId: input.actorPublicId ?? profile.actor_public_id,
    actorName: input.actorName ?? profile.actor_name,
    ...((input.actorAvatarUrl ?? profile.actor_avatar_url)
      ? { actorAvatarUrl: input.actorAvatarUrl ?? profile.actor_avatar_url }
      : {}),
  }
}
function fixtureJti(prefix = "jti") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

const runtimeAccessTokenSigner = async (input) => {
  const now = Date.now()
  const jti = fixtureJti()
  return {
    jti,
    tokenExpiresAt: now + tokenTtlSeconds * 1_000,
    runtimeAccessToken: await mintRuntimeAccessToken(
      withRuntimeActor({
        subject: input.subject,
        principalKind: input.principalKind,
        actorId: input.actorId,
        actorKind: input.actorKind,
        actorPublicId: input.actorPublicId,
        actorName: input.actorName,
        ...(input.actorAvatarUrl ? { actorAvatarUrl: input.actorAvatarUrl } : {}),
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        hostId: input.hostId,
        role: input.role,
        ttlSeconds: tokenTtlSeconds,
        jti,
        now,
      }),
      runtime.privateKey,
      "EdDSA",
    ),
  }
}
const centralStore = createSqliteCentralStore({ mode: () => "central_canonical" })
const services = createControlPlaneServices(
  {
    projectionStore: centralStore.projectionStore,
    durableSessionLog: centralStore.durableSessionLog,
  },
  {
    auth: customVerifierAuthAdapter({
      issuer: jwksIssuer.issuer,
      audience: controlPlaneAudience,
      jwksUrl: jwksIssuer.jwksUrl,
      verifier: controlPlaneVerifier,
    }),
    // The real self-host `WorkspaceAuthority`, injected here the way the
    // production self-host composition injects its own — never assigned onto
    // `services` by mutation after `createSelfHostedApp`.
    authority,
    relay: {
      relayUrl: publicRelayUrl,
      runtimeAccessTokenSigner,
      ...(hostMode === "connect" ? { resolverToken, hostTunnelTokenSigner: hostTunnelTokenSigner(process.env) } : {}),
      hostTunnelResolver: createSqliteHostTunnelTargetResolver(),
      // `proxy.ts`'s `localWorkspaceRelayProxy` is the path the
      // app actually takes for a relay-backed workspace on a LOOPBACK server URL
      // (`workspace-runtime-request.ts:223` — the relay is used directly only
      // when `preferRelayOnLoopback`, i.e. signed mode). That proxy forwards to
      // the cloud-vm or machine-placed runtime behind relay-host auth, and it mints the
      // required token ONLY when a `relayProvider` is configured AND the
      // workspace row carries an `org_id` (`proxy.ts:105`). Without both, every
      // forwarded request arrives with the browser's own bearer token and the
      // runtime answers 401 `invalid_relay_token` — which is what made the cloud
      // gate hang at "connecting" forever.
      //
      // Only `mintRuntimeAccessToken` is exercised by that path; the rest of the
      // interface throws rather than returning a plausible-looking lie, so a
      // future caller gets a loud failure instead of a silent wrong answer.
      provider: {
        getRelayEndpoint: () => relayUrl,
        mintRuntimeAccessToken: async (input) => {
          const now = Date.now()
          const jti = fixtureJti("relay_provider")
          return {
            jti,
            expiresAt: now + input.ttlMs,
            token: await mintRuntimeAccessToken(
              withRuntimeActor({
                subject: input.subject,
                ...(input.principalKind ? { principalKind: input.principalKind } : {}),
                orgId: input.orgId,
                workspaceId: input.workspaceId,
                hostId: input.hostId,
                role: input.role ?? "owner",
                ttlSeconds: Math.ceil(input.ttlMs / 1_000),
                jti,
                now,
                ...(input.actorId && input.actorKind
                  ? {
                      actorId: input.actorId,
                      actorKind: input.actorKind,
                      ...(input.actorPublicId && input.actorName
                        ? {
                            actorPublicId: input.actorPublicId,
                            actorName: input.actorName,
                            ...(input.actorAvatarUrl ? { actorAvatarUrl: input.actorAvatarUrl } : {}),
                          }
                        : {}),
                    }
                  : {}),
              }),
              runtime.privateKey,
              "EdDSA",
            ),
          }
        },
        mintHostTunnelToken: () => {
          throw new Error("signed-browser-relay-fixture: mintHostTunnelToken is not used")
        },
        resolveTarget: () => {
          throw new Error("signed-browser-relay-fixture: relayProvider.resolveTarget is not used")
        },
        drainWorkspace: () => {
          throw new Error("signed-browser-relay-fixture: relayProvider.drainWorkspace is not used")
        },
      },
    },
    sandbox: {
      sandboxManager: createWorkspaceSupervisorSandboxManager(),
    },
  },
)
const sessionTitle = backing === "cloud-vm" ? "Signed cloud relay session" : "Signed browser relay session"
const sessionRegistration = {
  operationId: "op_signed_browser_relay",
  sessionId: "signed-browser-relay-session",
  workspaceId,
  title: sessionTitle,
}
// The embedded host's canned session, seeded through the real private-session
// protocol; connect mode has no workspace at boot to seed one into.
if (hostMode === "embedded") {
  await services.projectionStore.sync_session_meta(effectiveWorkspace, {
    id: "signed-browser-relay-session",
    title: sessionTitle,
    directory: workspaceDir,
    time: { created: 1, updated: 2 },
  })
  services.durableSessionLog.persist_message_event("signed-browser-relay-session", {
    type: "message.updated",
    properties: {
      info: {
        id: "msg_signed_browser_relay",
        sessionID: "signed-browser-relay-session",
        role: "user",
        time: { created: 1 },
      },
    },
  })
  services.durableSessionLog.persist_message_event("signed-browser-relay-session", {
    type: "message.part.updated",
    properties: {
      part: {
        id: "part_signed_browser_relay",
        sessionID: "signed-browser-relay-session",
        messageID: "msg_signed_browser_relay",
        type: "text",
        text: backing === "cloud-vm" ? "Signed cloud relay replay message" : "Signed browser relay replay message",
      },
    },
  })
  const sessionMessages = [
    {
      info: {
        id: "msg_signed_browser_relay",
        sessionID: "signed-browser-relay-session",
        role: "user",
        time: { created: 1 },
      },
      parts: [
        {
          id: "part_signed_browser_relay",
          sessionID: "signed-browser-relay-session",
          messageID: "msg_signed_browser_relay",
          type: "text",
          text: backing === "cloud-vm" ? "Signed cloud relay replay message" : "Signed browser relay replay message",
        },
      ],
    },
  ]
  // Seed the canned session into the REAL private-session authority through the
  // SAME protocol a real host runs, under the SAME identity that registered the
  // workspace above.
  //
  // Both stores are seeded because they answer different routes: `GET /sessions`
  // on a signed-hosted-browser request answers ONLY from
  // `requireAuthority(services).listSessions` (`session/routes/control-plane-
  // session.ts`), so the session appears in the sidebar only via the authority;
  // `GET /sessions/:id/messages` prefers `projectionStore`'s replay log when
  // non-empty and falls back to the authority, so the durable-log writes above
  // are what serve message content.
  //
  // The authority half is a four-step protocol, not a single write, and every
  // step is the production one:
  //   1. `reserveSession` — the authenticated reservation boundary the runtime
  //      crosses before creating a session (`routes/private-session-registration
  //      .ts`'s `POST /reserve`).
  //   2. `registerRuntimeSession` — the RHT-authenticated runtime half that
  //      creates the `session_history` row and its creator participant.
  //   3. `acquireSessionTurn` — turn admission. It mints the fencing token AND
  //      records the admitted producer for `turnId`; `syncSessionMessages`
  //      rejects a snapshot whose user message has no admitted producer, and
  //      stamps that producer as the message's canonical author, so `turnId`
  //      must be the user message's own id.
  //   4. `syncSessionMessages` carrying that fencing token, then
  //      `releaseSessionTurn` — exactly what a host does when it checkpoints a
  //      completed turn (`authority/hosted-session-pull.ts` forwards the
  //      runtime snapshot's `fencingToken` the same way).
  const seedRuntimePrincipal = {
    principalKind: "user",
    actorId: browserActor.actor_id,
    actorKind: browserActor.actor_kind,
  }
  await authority.reserveSession(browserAuth, { ...sessionRegistration, kind: "create" })
  await authority.registerRuntimeSession({ ...seedRuntimePrincipal, ...sessionRegistration })
  const seedTurn = await authority.acquireSessionTurn({
    ...seedRuntimePrincipal,
    sessionId: sessionRegistration.sessionId,
    workspaceId,
    turnId: "msg_signed_browser_relay",
  })
  await authority.syncSessionMessages(browserAuth, {
    sessionId: sessionRegistration.sessionId,
    workspaceId,
    messages: sessionMessages,
    fencingToken: seedTurn.fencingToken,
  })
  await authority.releaseSessionTurn({
    ...seedRuntimePrincipal,
    sessionId: seedTurn.sessionId,
    workspaceId,
    turnId: seedTurn.turnId,
    leaseId: seedTurn.leaseId,
    fencingToken: seedTurn.fencingToken,
  })
}

// The full production entry point configures embedded execution immediately
// after building this app. This focused fixture injects its own services and
// therefore calls the same canonical authority-policy factory explicitly
// before any tunnel request can create the runtime host.
configureEmbeddedWorkspaceRuntime({
  sessionAccessPolicy: embeddedSessionPolicy,
})

const built = createSelfHostedApp(services, {
  // A production browser normally reuses one document/token. This load suite
  // deliberately boots many fresh documents against one fixture; keep the
  // production limiter implementation while sizing its explicit test budget
  // for that workload.
  connectionRateLimiter: createFixedWindowConnectionRateLimiter({ limit: 10_000, windowMs: 60_000 }),
})
if (backing === "local-worktree" && hostMode === "embedded") {
  // Tunnel startup can create/cache the workspace runtime, and runtime policy
  // configuration is intentionally not retroactive. Start only after the
  // authority-backed factory above is ready.
  await startWorkspaceHostTunnel({
    workspaceId,
    hostId,
    relayUrl,
    hostTunnelToken: await mintHostTunnelToken(
      {
        subject: "user_host",
        hostId,
        workspaceIds: [workspaceId],
      },
      runtime.privateKey,
      "EdDSA",
    ),
  })
}
// The request wrapper below observes and delays machine-facing requests; every
// route is answered by the self-host composition itself.
const faults = createFaults()
const connectInstances = createConnectInstances({
  homesRoot: path.join(root, "connect-homes"),
  controlPlaneUrl: backendUrl,
})
built.app.post("/__fixture/oauth/token", async (c) => {
  const form = new URLSearchParams(await c.req.text())
  if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== currentDesktopRefreshToken) {
    return c.json({ error: "invalid_grant" }, 400)
  }
  desktopRefreshes += 1
  currentDesktopRefreshToken = `desktop_refresh_${desktopRefreshes}`
  return c.json({
    access_token: await jwksIssuer.mint({
      subject: browserSubject,
      audience: controlPlaneAudience,
      ttlSeconds: 3600,
    }),
    refresh_token: currentDesktopRefreshToken,
    expires_in: 3600,
  })
})
built.app.get("/__fixture/desktop-stats", (c) =>
  c.json({
    refreshes: desktopRefreshes,
    hostRequests: desktopHostRequests,
  }),
)

// Debug-only surface for live-host-tunnel-relay.spec.ts (Tier L). NOT part of
// the product API — these routes exist so the spec can drive real host-tunnel
// lifecycle events (pause/resume) and mint an arbitrary-role token against
// the SAME already-running workspace/relay/tunnel, without spinning up a
// second full fixture process per role. Real @claxedo/workspace-relay JWT
// minting and the real host tunnel lifecycle
// (start/stopWorkspaceHostTunnel) are exercised either way — this is
// test orchestration, not a mocked response.
if (hostMode === "embedded") built.app.get("/__fixture/mint", async (c) => {
  const role = c.req.query("role")
  if (role !== "viewer" && role !== "editor" && role !== "owner" && role !== "admin") {
    return c.json({ error: "role must be one of viewer|editor|owner|admin" }, 400)
  }
  const now = Date.now()
  const token = await mintRuntimeAccessToken(
    withRuntimeActor({
      subject: "user_browser",
      orgId: fixtureOrgId,
      workspaceId,
      // Must match whatever host identity the runtime was configured with, or the
      // relay rejects this token with `relay_token_host_mismatch`. In cloud mode
      // that identity is the WORKSPACE id (see `startCloudRuntime`'s note) — the
      // same value the product's own `/api/workspace/:id/connection` mints.
      hostId: backing === "cloud-vm" ? workspaceId : hostId,
      role,
      ttlSeconds: tokenTtlSeconds,
      jti: `fixture_mint_${now}`,
      now,
    }),
    runtime.privateKey,
    "EdDSA",
  )
  return c.json({ role, runtimeAccessToken: token, relayUrl, tokenExpiresAt: now + tokenTtlSeconds * 1_000 })
})
// A teammate identity: a second control-plane JWT from the same issuer for a
// distinct `sub` (the sqlite authority upserts one row per `token_identifier`),
// ranked on the project behind this fixture's workspace at the requested
// role. `projectMembership=0` withholds that rank.
built.app.get("/__fixture/authority-identity", async (c) => {
  const subject = c.req.query("subject")
  const role = c.req.query("role")
  const name = c.req.query("name")?.trim()
  const projectMembership = c.req.query("projectMembership") !== "0"
  const joinOrg = c.req.query("joinOrg") === "1"
  // Connect mode has no fixed workspace, so the rank names the project behind
  // the one the owner assigned; the embedded lanes keep their single workspace.
  const sharedWorkspaceId = c.req.query("workspaceId") ?? workspaceId
  if (!subject) return c.json({ error: "subject is required" }, 400)
  if (role !== "viewer" && role !== "editor" && role !== "admin") {
    return c.json({ error: "role must be one of viewer|editor|admin" }, 400)
  }
  const tokenIdentifier = `${jwksIssuer.issuer}|${subject}`
  await authority.usersMe({
    mode: "signed",
    token: "",
    user: {
      subject,
      tokenIdentifier,
      issuer: jwksIssuer.issuer,
    },
  })
  if (joinOrg) {
    // The organization that owns the workspace, not the fixture's own: a
    // connect host's workspace lands in the owner's personal org, and being a
    // member of THAT org is what makes a teammate offerable a session share.
    const owningOrg = authorityDb()
      .prepare(`SELECT org_id FROM workspaces WHERE workspace_id = ?`)
      .get(sharedWorkspaceId)
    if (!owningOrg) return c.json({ error: `joinOrg found no workspace ${sharedWorkspaceId}` }, 400)
    const now = Date.now()
    authorityDb().prepare(`
      INSERT INTO org_memberships (org_id, token_identifier, role, created_at, updated_at)
      VALUES (?, ?, 'member', ?, ?)
      ON CONFLICT (org_id, token_identifier) DO UPDATE SET role = 'member', updated_at = excluded.updated_at
    `).run(owningOrg.org_id, tokenIdentifier, now, now)
  }
  if (name) {
    upsertUser(authorityDb(), {
      token_identifier: tokenIdentifier,
      subject,
      issuer: jwksIssuer.issuer,
      name,
      kind: "human",
    })
  }
  // Org→Team proofs mint Bob with no rank of his own so access comes from
  // team membership + team_project_grants. Casey keeps the project rank
  // (default) to prove workspace access alone does not unlock sessions.
  if (projectMembership) {
    const now = Date.now()
    const project = authorityDb()
      .prepare(`SELECT project_id FROM workspaces WHERE workspace_id = ?`)
      .get(sharedWorkspaceId)
    if (!project?.project_id) return c.json({ error: "fixture workspace has no project" }, 500)
    authorityDb().prepare(`
      INSERT INTO project_memberships (project_id, token_identifier, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (project_id, token_identifier) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at
    `).run(project.project_id, tokenIdentifier, role, now, now)
  }
  const token = await jwksIssuer.mint({ subject, audience: controlPlaneAudience, ttlSeconds: 3600 })
  return c.json({ subject, tokenIdentifier, role, controlPlaneToken: token, ...(name ? { name } : {}) })
})
if (hostMode === "connect") {
  connectFixtureRoutes(built.app, {
    instances: connectInstances,
    faults,
    authority,
    ownerSubject: browserSubject,
    orgId: fixtureOrgId,
    runtimePrivateKey: runtime.privateKey,
    relayHostPrivateKey: relayHost.privateKey,
    relayHostPublicKey: relayHostPublicKeyFrom(relayHostPrivateKeyJwk),
    hostTunnelTokenSigner: services.relay.hostTunnelTokenSigner,
    authFor: (subject) => ({
      mode: "signed",
      token: "",
      user: { subject, tokenIdentifier: `${jwksIssuer.issuer}|${subject}`, issuer: jwksIssuer.issuer },
    }),
  })
} else if (backing !== "cloud-vm") {
  built.app.post("/__fixture/tunnel/pause", async (c) => {
    const stopped = stopWorkspaceHostTunnel({ workspaceId, hostId })
    return c.json({ paused: stopped })
  })
  built.app.post("/__fixture/tunnel/resume", async (c) => {
    const result = await startWorkspaceHostTunnel({
      workspaceId,
      hostId,
      relayUrl,
      hostTunnelToken: await mintHostTunnelToken(
        {
          subject: "user_host",
          hostId,
          workspaceIds: [workspaceId],
        },
        runtime.privateKey,
        "EdDSA",
      ),
    })
    return c.json({ resumed: true, reused: result.reused })
  })
} else {
  // Cloud-mode peers of the host tunnel routes above. There is no host
  // tunnel to stop in this shape — the relay forwards straight to the injected
  // cloud runtime — so pausing means refusing at that runtime instead. Same
  // purpose for `real-cloud-relay.spec.ts` as pause/resume serve for the
  // machine-placed spec: prove the relay hop is load-bearing by breaking it.
  built.app.post("/__fixture/cloud-runtime/pause", (c) => {
    if (cloudRuntime) cloudRuntime.stats.paused = true
    return c.json({ paused: !!cloudRuntime })
  })
  built.app.post("/__fixture/cloud-runtime/resume", (c) => {
    if (cloudRuntime) cloudRuntime.stats.paused = false
    return c.json({ resumed: !!cloudRuntime })
  })
  built.app.get("/__fixture/cloud-runtime/stats", (c) =>
    c.json({ forwarded: cloudRuntime?.stats.forwarded ?? 0, paused: cloudRuntime?.stats.paused ?? false }),
  )
}

function withConnectionClose(response) {
  if (response.status === 101) return response
  const headers = new Headers(response.headers)
  headers.set("connection", "close")
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

const server = serve({
  fetch: async (request, ...rest) => {
    const url = new URL(request.url)
    const outage = faults.outage(url)
    if (outage) return withConnectionClose(outage)
    if (url.pathname.startsWith("/api/claxedo/host/enrollments")) {
      const body =
        request.method === "POST"
          ? await request
              .clone()
              .json()
              .catch(() => undefined)
          : undefined
      desktopHostRequests.push({
        method: request.method,
        path: url.pathname,
        body,
        phase: "started",
        at: Date.now(),
      })
      if (url.pathname.endsWith("/heartbeat") && hostHeartbeatDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, hostHeartbeatDelayMs))
      }
      const response = await faults.holdRedeem(url, await built.app.fetch(request, ...rest))
      desktopHostRequests.push({
        method: request.method,
        path: url.pathname,
        phase: "completed",
        status: response.status,
        // The redeem answer is the one machine-side response a spec cannot
        // read from the CLI's own output, so its body is kept for assertions
        // on what a refusal discloses.
        ...(url.pathname.endsWith("/redeem") ? { body: await response.clone().json().catch(() => undefined) } : {}),
        at: Date.now(),
      })
      return withConnectionClose(response)
    }
    return withConnectionClose(await built.app.fetch(request, ...rest))
  },
  port: backendPort || 0,
  hostname: "127.0.0.1",
})
attachHttpServerErrorHandlers(server)
built.injectWebSocket(server)
const boundPort = await serverPort(server, "Signed browser relay backend")
configureRuntimeSessionAuthorityUrl(`http://127.0.0.1:${boundPort}`)

const connectInfo = () => ({
  hostMode,
  backendUrl: `http://127.0.0.1:${boundPort}`,
  relayUrl,
  orgId: fixtureOrgId,
  roots: connectRoots,
  resolverToken,
  hostJwksUrl: process.env.CLAXEDO_RELAY_HOST_JWKS_URL,
  sessionAuthorityUrl: process.env.CLAXEDO_SESSION_AUTHORITY_URL,
  controlPlaneToken: browserControlPlaneToken,
  controlPlaneIssuer: jwksIssuer.issuer,
  ownerSubject: browserSubject,
  ownerActor: {
    actor_id: browserActor.actor_id,
    actor_public_id: browserActor.actor_public_id,
    actor_name: browserActor.actor_name,
  },
})
if (hostMode === "connect") console.log(JSON.stringify(connectInfo()))
else console.log(
  JSON.stringify({
    backendUrl: `http://127.0.0.1:${boundPort}`,
    relayUrl,
    workspaceId,
    hostId,
    orgId: fixtureOrgId,
    // The session this fixture registered and seeded through the private-session
    // protocol above. Managed workspace-runtime routes are session-scoped — PTY
    // creation refuses a request without a `sessionId`
    // (`workspace-runtime/src/routes/pty.ts`'s `pty_session_id_required`) — so a
    // consumer needs the real id rather than a literal of its own.
    sessionId: sessionRegistration.sessionId,
    ...(fixtureDefaultTeamId ? { defaultTeamId: fixtureDefaultTeamId } : {}),
    runtimeAccessToken: await mintRuntimeAccessToken(
      withRuntimeActor({
        subject: "user_browser",
        orgId: fixtureOrgId,
        workspaceId,
        // Same host-identity rule as `/__fixture/mint` above.
        hostId: backing === "cloud-vm" ? workspaceId : hostId,
        role,
        ttlSeconds: 120,
        jti: `fixture_${Date.now()}`,
        now: Date.now(),
      }),
      runtime.privateKey,
      "EdDSA",
    ),
    role,
    workspaceDir,
    directory: workspaceDir,
    // Real, signed control-plane bearer token for `browserSubject` — see the
    // block above `authority = createSqliteWorkspaceAuthority()` for what
    // verifies it and why no current spec consumes this field yet.
    controlPlaneToken: browserControlPlaneToken,
    controlPlaneIssuer: jwksIssuer.issuer,
    ownerActor: {
      actor_id: browserActor.actor_id,
      actor_public_id: browserActor.actor_public_id,
      actor_name: browserActor.actor_name,
    },
    desktopRefreshToken,
  }),
)

let shutdownPromise
function shutdown() {
  if (shutdownPromise) return shutdownPromise
  shutdownPromise = (async () => {
    if (localHostHeartbeatTimer) clearInterval(localHostHeartbeatTimer)
    await localHostHeartbeatPromise
    faults.setRedeemResponseDrop(false)
    await connectInstances.stopAll()
    await closeHttp(server)
    await relay.close()
    stopAllWorkspaceHostTunnels()
    await cloudRuntime?.close()
    await shutdownWorkspaceSupervisor()
    await jwksIssuer.close()
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
  })()
  return shutdownPromise
}

// The harness owns this process through a pipe, not a health check against a
// possibly stale listener. Parent death closes the pipe even on SIGKILL.
process.stdin.resume()
process.stdin.on("error", () => {})
process.stdin.once("end", () => {
  shutdown().finally(() => process.exit(0))
})

process.on("uncaughtException", (error) => {
  if (error?.code === "ECONNRESET" || error?.code === "EPIPE") {
    console.error("signed-browser-relay-fixture: ignored benign socket reset")
    return
  }
  console.error(error)
  process.exit(1)
})

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0))
})

process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0))
})

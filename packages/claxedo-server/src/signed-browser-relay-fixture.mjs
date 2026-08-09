import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile, spawn } from "node:child_process"
import { createServer } from "node:http"
import { promisify } from "node:util"
import { once } from "node:events"
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { createRemoteJWKSet, exportJWK, generateKeyPair, jwtVerify } from "jose"
import {
  mintHostTunnelToken,
  mintRuntimeAccessToken,
} from "@claxedo/workspace-relay"
import { createWorkspaceRuntimeApp } from "../../workspace-runtime/src/server.ts"
import { relayWorkspaceRuntimeExposure } from "../../workspace-runtime/src/exposure.ts"
import { createSelfHostedApp } from "./deployments/self-hosted-node/app"
import { opencodeRequest } from "@claxedo/server-core/opencode/engine"
import { createControlPlaneServices } from "./authority/services.ts"
import { createSqliteCentralStore } from "./authority/adapters/sqlite/central-store.ts"
import { createSqliteWorkspaceAuthority } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority"
import { customVerifierAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import { startLocalJwksIssuer } from "./e2e-local-jwks-issuer.mjs"
// PRE-EXISTING BREAKAGE, fixed in passing: `refactor(server): group the
// workspace supervisor and store into directories` (78d734a70) moved this
// module to `index.ts`, then `refactor(server): W7.1-7.5` (7776fc9f1) deleted
// the old `supervisor.ts` outright — but never updated this import, so this
// fixture 500'd at module-resolution time (`ERR_MODULE_NOT_FOUND`) before
// this line was fixed, independent of and prior to the Phase 3 control-plane
// swap. Verified: `find packages/claxedo-server/src -name supervisor.ts`
// returns nothing; `workspace/supervisor/index.ts` exports every symbol below.
import { configureWorkspaceSupervisor, createWorkspaceSupervisorSandboxManager, injectRuntime, shutdownWorkspaceSupervisor } from "./workspace/supervisor/index.ts"
import { recordSupervisorSandboxLeaseReady } from "./sandbox/stores/sqlite-supervisor-state.ts"
import { ensureWorkspace, updateWorkspace } from "@claxedo/server-core/workspace/store/index"
import { startUserHostedWorkspaceTunnel, stopAllUserHostedWorkspaceTunnels, stopUserHostedWorkspaceTunnel } from "./user-hosted-tunnel.ts"
import { HostEnrollmentRoutes } from "./routes/hosted/host-enrollment.ts"

const execFileAsync = promisify(execFile)
const workspaceId = process.env.CLAXEDO_E2E_WORKSPACE_ID?.trim() || "ws_signed_browser_relay"
const hostId = process.env.CLAXEDO_E2E_HOST_ID?.trim() || "host_signed_browser_relay"
const projectId = "proj_signed_browser_relay"
const access = process.env.CLAXEDO_E2E_RELAY_FIXTURE_ACCESS === "cloud" ? "cloud" : "user-hosted"
const requestedRole = process.env.CLAXEDO_E2E_RELAY_FIXTURE_ROLE?.trim()
const role = requestedRole === "viewer" || requestedRole === "editor" || requestedRole === "owner"
  ? requestedRole
  : "editor"
const backendPort = Number(process.env.CLAXEDO_E2E_BACKEND_PORT || 0)
// Overridable so live-user-hosted-relay.spec.ts's token-refresh scenario can
// force `tokenExpiresAt` inside `refreshWindowMs` (default 60s, see
// `src/utils/workspace-relay-connection.ts`'s `ensureFresh`) almost
// immediately after mint, without waiting out a real 120s TTL.
const tokenTtlSeconds = Number(process.env.CLAXEDO_E2E_RELAY_FIXTURE_TOKEN_TTL_SECONDS || 120)
const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-signed-browser-relay-"))
const dataDir = path.join(root, "data")
const workspaceDir = path.join(root, "workspace")
const opencodeRequests = []
const desktopRefreshToken = "desktop_refresh_0"
let currentDesktopRefreshToken = desktopRefreshToken
let desktopRefreshes = 0
const desktopHostRequests = []
const hostHeartbeatDelayMs = Number(process.env.CLAXEDO_E2E_HOST_HEARTBEAT_DELAY_MS || 0)
const runtimeConfigToken = "signed-browser-relay-runtime-config"
let cloudRuntime

process.env.CLAXEDO_DATA_DIR = dataDir
process.env.CLAXEDO_RELAY_JWT_ALG = "EdDSA"
process.env.WORKSPACE_RUNTIME_CONFIG_TOKEN = runtimeConfigToken

async function run(cwd, ...args) {
  await execFileAsync(args[0], args.slice(1), { cwd })
}

async function closeHttp(server) {
  await new Promise((resolve) => server.close(() => resolve()))
}

async function serverPort(server, label) {
  if (!server.listening) await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error(`${label} did not bind`)
  return address.port
}

async function forbiddenOpencodeServer() {
  const server = createServer((req, res) => {
    opencodeRequests.push(`${req.method || "GET"} ${req.url || "/"}`)
    const url = new URL(req.url || "/", "http://opencode.fixture")
    const session = {
      id: "signed-browser-relay-session",
      title: access === "cloud" ? "Signed cloud relay session" : "Signed browser relay session",
      directory: workspaceDir,
      time: { created: 1, updated: 2 },
    }
    const messages = [{
      info: {
        id: "msg_signed_browser_relay",
        sessionID: "signed-browser-relay-session",
        role: "user",
        time: { created: 1 },
      },
      parts: [{
        id: "part_signed_browser_relay",
        sessionID: "signed-browser-relay-session",
        messageID: "msg_signed_browser_relay",
        type: "text",
        text: access === "cloud" ? "Signed cloud relay replay message" : "Signed browser relay replay message",
      }],
    }]
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(body))
    }
    if (req.method === "GET" && url.pathname === "/session") return json(200, [session])
    if (req.method === "GET" && url.pathname === "/session/signed-browser-relay-session") return json(200, session)
    if (req.method === "GET" && url.pathname === "/session/signed-browser-relay-session/message") return json(200, messages)
    if (req.method === "GET" && url.pathname === "/session/signed-browser-relay-session/todo") return json(200, [])
    if (req.method === "GET" && url.pathname === "/permission") return json(200, [])
    if (req.method === "GET" && url.pathname === "/question") return json(200, [])
    json(599, { error: "old opencode path should not be used", path: url.pathname })
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Forbidden OpenCode server did not bind")
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => closeHttp(server),
  }
}

async function startCloudRuntime(input) {
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
    // The REAL in-process engine transport, same one `startOwnedControlPlaneStack`
    // hands the embedded runtime. Pointing this at `forbiddenOpencodeServer()`
    // instead (as it was) makes every real session route 599 by design — that
    // stub exists to prove the OLD external-URL path is dead, not to serve
    // traffic. `opencodeCompat` must be explicitly true or the Session V2
    // routes (`/api/session*`, `/api/model`) answer 503 `session_v2_unavailable`
    // (`workspace/runtime.ts:1733`).
    opencodeRequest,
    opencodeCompat: true,
  })
  // Every request the relay forwards to this cloud runtime passes through here.
  // Two jobs, both for `real-cloud-relay.spec.ts`:
  //   1. COUNT — the spec asserts a real turn incremented this. The runtime is a
  //      separate HTTP server the browser has no URL for, so a non-zero count is
  //      positive proof the traffic genuinely crossed the relay hop rather than
  //      being served by anything the page could reach directly.
  //   2. PAUSE — cloud mode has no host tunnel to stop (that is the user-hosted
  //      shape), so `/__fixture/tunnel/pause` does not exist here. This gate is
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
    close: () => closeHttp(server),
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

async function startRelayFixture(input) {
  const logs = []
  const child = spawn("bun", ["src/user-hosted-relay-fixture.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAXEDO_RELAY_FIXTURE_WORKSPACE_ID: workspaceId,
      CLAXEDO_RELAY_FIXTURE_HOST_ID: hostId,
      CLAXEDO_RELAY_FIXTURE_RUNTIME_PUBLIC_KEY_JWK: JSON.stringify(input.runtimePublicKeyJwk),
      CLAXEDO_RELAY_FIXTURE_HOST_PRIVATE_KEY_JWK: JSON.stringify(input.relayHostPrivateKeyJwk),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  return await new Promise((resolve, reject) => {
    let settled = false
    let stdout = ""
    const fail = (err) => {
      if (settled) return
      settled = true
      stopChild(child).finally(() => reject(err))
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
await run(workspaceDir, "git", "-c", "user.email=fixture@example.test", "-c", "user.name=Relay Fixture", "commit", "-m", "initial")
await fs.appendFile(path.join(workspaceDir, "hello.txt"), "relay diff line\n")

const runtime = await generateKeyPair("EdDSA", { extractable: true })
const relayHost = await generateKeyPair("EdDSA", { extractable: true })
process.env.CLAXEDO_RELAY_HOST_PUBLIC_KEY_JWK = JSON.stringify(await exportJWK(relayHost.publicKey))

const relay = await startRelayFixture({
  runtimePublicKeyJwk: await exportJWK(runtime.publicKey),
  relayHostPrivateKeyJwk: await exportJWK(relayHost.privateKey),
})
const relayUrl = relay.url
const backendUrl = `http://127.0.0.1:${backendPort || 0}`
const opencode = await forbiddenOpencodeServer()

configureWorkspaceSupervisor({
  server_url: backendUrl,
})

const workspace = await ensureWorkspace({
  workspaceId,
  project_id: projectId,
  directory: workspaceDir,
  kind: "local",
  workspace_name: "Signed Browser Relay",
  // Cloud mode needs this on the row for the loopback relay proxy to mint a
  // runtime access token (`proxy.ts:105` gates on `relayProvider && ws.org_id`).
  // Set at CREATE time: `updateWorkspace`'s patch type does not include
  // `org_id`, so patching it later type-checks as an unrelated key.
  ...(access === "cloud" ? { org_id: "personal" } : {}),
})
if (!workspace) throw new Error("Signed browser relay workspace was not stored")

let effectiveWorkspace = workspace
if (access === "cloud") {
  cloudRuntime = await startCloudRuntime({
    relayHostPublicKey: relayHost.publicKey,
  })
  const cloudWorkspace = await updateWorkspace(workspaceId, {
    kind: "cloud",
    status: "ready",
    sandbox_id: hostId,
  })
  effectiveWorkspace = cloudWorkspace ?? workspace
  recordSupervisorSandboxLeaseReady({
    workspaceId,
    driver: "cloudflare",
    sandboxId: hostId,
    driverResourceId: hostId,
    url: cloudRuntime.url,
  })
  injectRuntime(effectiveWorkspace, cloudRuntime.url)
} else {
  await startUserHostedWorkspaceTunnel({
    workspaceId,
    hostId,
    relayUrl,
    hostTunnelToken: await mintHostTunnelToken({
      subject: "user_host",
      hostId,
      workspaceIds: [workspaceId],
    }, runtime.privateKey, "EdDSA"),
  })
}

// --- REAL control-plane auth + authority (2026-08-06 plan Phase 3) ---------
//
// Owner decision 1 (docs/plans/2026-08-06-001-test-full-matrix-real-e2e-plan.md):
// "no only thing that needs to be stubbed is harness called ai endpoint
// nothing else stubbed." Before this change, this fixture declared local
// `authConfig`/`verifier` consts right here that accepted ANY bearer string
// and echoed it back as the verified subject — zero cryptographic
// verification — and `services.authority` (assigned by mutation further
// down, now deleted) was a hand-rolled object literal that answered every
// call with a canned `workspaceRow`, never touching a real store. Neither
// exercised the code every real deployment runs.
//
// What replaces them:
//   - `startLocalJwksIssuer()` (`./e2e-local-jwks-issuer.mjs`) runs a REAL
//     HTTP JWKS endpoint backed by a REAL EdDSA keypair (`node:crypto`
//     webcrypto via `jose`, already a dependency — no new one added).
//   - `controlPlaneVerifier` below does REAL `jose.jwtVerify()` against that
//     endpoint — the same shape `tokenVerifierAsClerk`/`betterAuthAdapter`
//     use in production (`platform/auth/auth.ts`), just pointed at this
//     issuer instead of Clerk.
//   - `customVerifierAuthAdapter` (`platform/auth/auth.ts:179`) wires the two
//     into `services.auth` — this is a documented, first-class adapter,
//     not a test-only seam; it is how a self-hoster plugs in Auth0/Ory/any
//     OIDC-shaped issuer instead of Clerk.
//   - `createSqliteWorkspaceAuthority()` (`authority/adapters/sqlite/
//     workspace-authority.ts`) is the SAME self-host `WorkspaceAuthority`
//     `deployments/self-hosted-node/app.ts:948`'s `createDefaultLocalControlPlaneServices`
//     composes when no `CLAXEDO_WORKSPACE_AUTHORITY_URL` (Convex) is set —
//     full role/session/sharing model, mirrored 1:1 from the Convex backend,
//     backed by a real SQLite file under this fixture's own
//     `CLAXEDO_DATA_DIR` (set above, so it lands in the same hermetic
//     `mkdtemp` root as `createSqliteCentralStore` and is deleted with it).
//
// LIMIT, stated verbatim per the plan: a local JWKS issuer is a SUPPORTED
// SELF-HOST MODE, not a stub — same middleware, same real crypto — but
// Clerk-specific behaviour (its actual token shape, its JWKS rotation
// cadence, its session-claim vocabulary) is covered only by the nightly
// credentialed `live-*` lane (`e2e/INVARIANTS.md`), which runs against a real
// Clerk test tenant. Nothing here proves this fixture matches Clerk's wire
// format — only that the CONTROL PLANE's own auth/authority code, exercised
// with a real signed token, behaves correctly.
const jwksIssuer = await startLocalJwksIssuer()
const controlPlaneAudience = "claxedo-e2e-relay-fixture"
const controlPlaneJwks = createRemoteJWKSet(new URL(jwksIssuer.jwksUrl))
const controlPlaneVerifier = async (token, config) => {
  const { payload } = await jwtVerify(token, controlPlaneJwks, {
    issuer: config.issuer,
    ...(config.audience ? { audience: config.audience } : {}),
  })
  const subject = typeof payload.sub === "string" ? payload.sub : undefined
  if (!subject) throw new Error("e2e control-plane JWT is missing a subject claim")
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
// A real, signed control-plane bearer token for that identity — printed in
// this fixture's stdout JSON (below) as `controlPlaneToken` so a spec can
// authenticate as `browserSubject` for real. NOTE: as of 2026-08-06 neither
// `real-cloud-relay.spec.ts` nor `live-user-hosted-relay.spec.ts` read this
// field yet — both still seed `window.__CLAXEDO_TEST_AUTH_TOKEN__` with a
// hardcoded literal (`real-cloud-relay.spec.ts:176`,
// `live-user-hosted-relay.spec.ts:536`), which `controlPlaneVerifier` above
// now REJECTS with 401 `invalid_bearer_token` (`platform/auth/auth.ts:335`)
// because it is not a JWT. That is a real, load-bearing gap this fixture
// alone cannot close — see the Phase 3 completion note at the bottom of this
// file for the exact fix required in those spec files.
const browserControlPlaneToken = await jwksIssuer.mint({
  subject: browserSubject,
  audience: controlPlaneAudience,
  ttlSeconds: 3600,
})

const authority = createSqliteWorkspaceAuthority()
if (access === "cloud") {
  await authority.createCloudWorkspace(browserAuth, {
    workspaceId,
    displayName: "Signed Cloud Relay",
    repoName: "opencode",
    gitBranch: "main",
  })
} else {
  await authority.registerLocalForSharing(browserAuth, {
    workspaceId,
    displayName: "Signed Browser Relay",
    // Real filesystem directory the embedded workspace-runtime actually
    // serves — `routes/bootstrap.ts`'s `signedBootstrapProjects()` reads
    // `remote_directory`, and the client's `sessionWorkspaceRuntimeRef`
    // inventory match needs this to agree with the real directory. NOTE:
    // `createCloudWorkspace` (used above for `access === "cloud"`) has NO
    // `remoteDirectory` parameter on the real `WorkspaceAuthority` port
    // (`platform/auth/authority.ts:158-172`) — this is a genuine gap in the
    // real port, not something this fixture can route around; cloud-mode
    // routing already gets its directory from the SEPARATE `workspace/store`
    // row (`ensureWorkspace`/`updateWorkspace`, above), which is unaffected.
    remoteDirectory: workspaceDir,
    repoName: "opencode",
    gitBranch: "main",
  })
}
const runtimeAccessTokenSigner = async (input) => {
  const now = Date.now()
  const jti = `jti_${now}`
  return {
    jti,
    tokenExpiresAt: now + tokenTtlSeconds * 1_000,
    runtimeAccessToken: await mintRuntimeAccessToken({
      subject: input.subject,
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      hostId: input.hostId,
      role: input.role,
      ttlSeconds: tokenTtlSeconds,
      jti,
      now,
    }, runtime.privateKey, "EdDSA"),
  }
}
const centralStore = createSqliteCentralStore({ mode: () => "central_canonical" })
const services = createControlPlaneServices({
  projectionStore: centralStore.projectionStore,
  durableSessionLog: centralStore.durableSessionLog,
}, {
  auth: customVerifierAuthAdapter({
    issuer: jwksIssuer.issuer,
    audience: controlPlaneAudience,
    jwksUrl: jwksIssuer.jwksUrl,
    verifier: controlPlaneVerifier,
  }),
  // Real self-host `WorkspaceAuthority`, injected at the composition site —
  // exactly the seam `authority/services.ts:220` documents ("the authority is
  // always injected by the composition site; the generic services never
  // construct one") and the same object `deployments/self-hosted-node/app.ts:948`
  // composes for production self-host. Replaces the hand-rolled
  // `services.authority = {...}` object literal that used to sit after
  // `createSelfHostedApp(services)` below — every method there returned a canned value
  // and touched no store.
  authority,
  relay: {
    relayUrl,
    runtimeAccessTokenSigner,
    // Cloud mode only. `proxy.ts`'s `localWorkspaceRelayProxy` is the path the
    // app actually takes for a relay-backed workspace on a LOOPBACK server URL
    // (`workspace-runtime-request.ts:223` — the relay is used directly only
    // when `preferRelayOnLoopback`, i.e. signed mode). That proxy forwards to
    // the cloud runtime, which sits behind relay-host auth, and it mints the
    // required token ONLY when a `relayProvider` is configured AND the
    // workspace row carries an `org_id` (`proxy.ts:105`). Without both, every
    // forwarded request arrives with the browser's own bearer token and the
    // runtime answers 401 `invalid_relay_token` — which is what made the cloud
    // gate hang at "connecting" forever.
    //
    // Only `mintRuntimeAccessToken` is exercised by that path; the rest of the
    // interface throws rather than returning a plausible-looking lie, so a
    // future caller gets a loud failure instead of a silent wrong answer.
    ...(access === "cloud"
      ? {
        provider: {
          getRelayEndpoint: () => relayUrl,
          mintRuntimeAccessToken: async (input) => {
            console.error("[DBG] relayProvider.mintRuntimeAccessToken called", JSON.stringify(input))
            const now = Date.now()
            const jti = `relay_provider_${now}`
            return {
              jti,
              expiresAt: now + input.ttlMs,
              token: await mintRuntimeAccessToken({
                subject: input.subject,
                orgId: input.orgId,
                workspaceId: input.workspaceId,
                hostId: input.hostId,
                role: input.role ?? "owner",
                ttlSeconds: Math.ceil(input.ttlMs / 1_000),
                jti,
                now,
              }, runtime.privateKey, "EdDSA"),
            }
          },
          mintHostTunnelToken: () => {
            throw new Error("signed-browser-relay-fixture: mintHostTunnelToken is not used in cloud mode")
          },
          resolveTarget: () => {
            throw new Error("signed-browser-relay-fixture: relayProvider.resolveTarget is not used")
          },
          drainWorkspace: () => {
            throw new Error("signed-browser-relay-fixture: relayProvider.drainWorkspace is not used")
          },
        },
      }
      : {}),
  },
  sandbox: {
    sandboxManager: createWorkspaceSupervisorSandboxManager(),
  },
})
await services.projectionStore.sync_session_meta(effectiveWorkspace, {
  id: "signed-browser-relay-session",
  title: access === "cloud" ? "Signed cloud relay session" : "Signed browser relay session",
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
      text: access === "cloud" ? "Signed cloud relay replay message" : "Signed browser relay replay message",
    },
  },
})
const sessionMessages = [{
  info: {
    id: "msg_signed_browser_relay",
    sessionID: "signed-browser-relay-session",
    role: "user",
    time: { created: 1 },
  },
  parts: [{
    id: "part_signed_browser_relay",
    sessionID: "signed-browser-relay-session",
    messageID: "msg_signed_browser_relay",
    type: "text",
    text: access === "cloud" ? "Signed cloud relay replay message" : "Signed browser relay replay message",
  }],
}]
// Register the canned session in the REAL authority too, under the SAME
// identity that registered the workspace above — `syncSessionMessages`
// requires "write" role on the workspace (`workspace-authority.ts:859`
// `requireWorkspace(db, who, args.workspaceId, "write")`), which `browserAuth`
// has because it is the workspace's `owner_token_identifier`
// (`workspaceRoleForUser` returns "owner" for the row owner unconditionally,
// same file, line 398).
//
// This is belt-and-suspenders with the `durableSessionLog`/`projectionStore`
// writes above, not a replacement for them — both are already REAL SQLite-
// backed stores (`createSqliteCentralStore`) and were never part of the
// hand-rolled control plane this phase removes. Why both are seeded:
// `GET /sessions` on a signed-hosted-browser request answers ONLY from
// `requireAuthority(services).listSessions` (`session/routes/control-plane-
// session.ts:373-400`) — the projection store is never consulted on that
// route — so the session would not appear in the sidebar without this call.
// `GET /sessions/:id/messages`, by contrast, prefers `projectionStore`'s
// replay log when non-empty and only falls back to the authority
// (`control-plane-session.ts:439-457`), so the durable-log writes above are
// what actually serves message content; this call exists so the authority's
// OWN answer is correct too, for whichever future caller reads it.
await authority.syncSessionMessages(browserAuth, {
  sessionId: "signed-browser-relay-session",
  workspaceId,
  messages: sessionMessages,
})

const built = createSelfHostedApp(services)
// This fixture predates the machine-wide Host Connector and deliberately uses
// the self-host composition for its embedded execution + relay paths. That
// composition must not own hosted machine-enrollment routes, so compose the
// canonical hosted route module beside it for the signed desktop lane. This is
// the production handler against the real SQLite authority, not a fixture
// response; the fixture wrapper below only observes/delays requests.
const desktopHostedRoutes = new Hono().route(
  "/api/claxedo/host/enrollments",
  HostEnrollmentRoutes(services, {
    authConfig: services.auth.config,
    ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
  }),
)
built.app.get("/__fixture/opencode-requests", (c) => c.json({ requests: opencodeRequests }))
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
built.app.get("/__fixture/desktop-stats", (c) => c.json({
  refreshes: desktopRefreshes,
  hostRequests: desktopHostRequests,
}))

// Debug-only surface for live-user-hosted-relay.spec.ts (Tier L). NOT part of
// the product API — these routes exist so the spec can drive real host-tunnel
// lifecycle events (pause/resume) and mint an arbitrary-role token against
// the SAME already-running workspace/relay/tunnel, without spinning up a
// second full fixture process per role. Real @claxedo/workspace-relay JWT
// minting and the real user-hosted tunnel lifecycle
// (start/stopUserHostedWorkspaceTunnel) are exercised either way — this is
// test orchestration, not a mocked response.
built.app.get("/__fixture/mint", async (c) => {
  const role = c.req.query("role")
  if (role !== "viewer" && role !== "editor" && role !== "owner" && role !== "admin") {
    return c.json({ error: "role must be one of viewer|editor|owner|admin" }, 400)
  }
  const now = Date.now()
  const token = await mintRuntimeAccessToken({
    subject: "user_browser",
    orgId: "personal",
    workspaceId,
    // Must match whatever host identity the runtime was configured with, or the
    // relay rejects this token with `relay_token_host_mismatch`. In cloud mode
    // that identity is the WORKSPACE id (see `startCloudRuntime`'s note) — the
    // same value the product's own `/api/workspace/:id/connection` mints.
    hostId: access === "cloud" ? workspaceId : hostId,
    role,
    ttlSeconds: tokenTtlSeconds,
    jti: `fixture_mint_${now}`,
    now,
  }, runtime.privateKey, "EdDSA")
  return c.json({ role, runtimeAccessToken: token, relayUrl, tokenExpiresAt: now + tokenTtlSeconds * 1_000 })
})
// Phase 3 checklist item: "'Shared/teammate' for user-hosted is a second
// identity minted by the same issuer" (2026-08-06 plan). Mints a REAL
// control-plane JWT for a distinct `sub` — the sqlite authority's `user()`
// upserts a distinct row per `token_identifier`
// (`workspace-authority.ts:205-213`) — and grants it a real share on this
// fixture's workspace via `grantWorkspaceShare` (same file, :555-579), the
// exact method the product's own "invite a teammate" flow calls. This is a
// same-mechanism variant of the owner identity above, not new plumbing.
built.app.get("/__fixture/authority-identity", async (c) => {
  const subject = c.req.query("subject")
  const role = c.req.query("role")
  if (!subject) return c.json({ error: "subject is required" }, 400)
  if (role !== "viewer" && role !== "editor" && role !== "admin") {
    return c.json({ error: "role must be one of viewer|editor|admin" }, 400)
  }
  const tokenIdentifier = `${jwksIssuer.issuer}|${subject}`
  await authority.grantWorkspaceShare(browserAuth, {
    workspaceId,
    role,
    grantedToTokenIdentifier: tokenIdentifier,
  })
  const token = await jwksIssuer.mint({ subject, audience: controlPlaneAudience, ttlSeconds: 3600 })
  return c.json({ subject, tokenIdentifier, role, controlPlaneToken: token })
})
if (access !== "cloud") {
  built.app.post("/__fixture/tunnel/pause", async (c) => {
    const stopped = stopUserHostedWorkspaceTunnel({ workspaceId, hostId })
    return c.json({ paused: stopped })
  })
  built.app.post("/__fixture/tunnel/resume", async (c) => {
    const result = await startUserHostedWorkspaceTunnel({
      workspaceId,
      hostId,
      relayUrl,
      hostTunnelToken: await mintHostTunnelToken({
        subject: "user_host",
        hostId,
        workspaceIds: [workspaceId],
      }, runtime.privateKey, "EdDSA"),
    })
    return c.json({ resumed: true, reused: result.reused })
  })
} else {
  // Cloud-mode peers of the user-hosted tunnel routes above. There is no host
  // tunnel to stop in this shape — the relay forwards straight to the injected
  // cloud runtime — so pausing means refusing at that runtime instead. Same
  // purpose for `real-cloud-relay.spec.ts` as pause/resume serve for the
  // user-hosted spec: prove the relay hop is load-bearing by breaking it.
  built.app.post("/__fixture/cloud-runtime/pause", (c) => {
    if (cloudRuntime) cloudRuntime.stats.paused = true
    return c.json({ paused: !!cloudRuntime })
  })
  built.app.post("/__fixture/cloud-runtime/resume", (c) => {
    if (cloudRuntime) cloudRuntime.stats.paused = false
    return c.json({ resumed: !!cloudRuntime })
  })
  built.app.get("/__fixture/cloud-runtime/stats", (c) =>
    c.json({ forwarded: cloudRuntime?.stats.forwarded ?? 0, paused: cloudRuntime?.stats.paused ?? false }))
}

const server = serve({
  fetch: async (request, ...rest) => {
    const url = new URL(request.url)
    if (url.pathname.startsWith("/api/claxedo/host/enrollments")) {
      const body = request.method === "POST"
        ? await request.clone().json().catch(() => undefined)
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
      const response = await desktopHostedRoutes.fetch(request, ...rest)
      desktopHostRequests.push({
        method: request.method,
        path: url.pathname,
        phase: "completed",
        status: response.status,
        at: Date.now(),
      })
      return response
    }
    return built.app.fetch(request, ...rest)
  },
  port: backendPort || 0,
  hostname: "127.0.0.1",
})
built.injectWebSocket(server)
const address = server.address()
if ((!address || typeof address === "string") && !backendPort) {
  throw new Error("Signed browser relay backend did not bind")
}
const boundPort = typeof address === "object" && address ? address.port : backendPort

console.log(JSON.stringify({
  backendUrl: `http://127.0.0.1:${boundPort}`,
  relayUrl,
  workspaceId,
  hostId,
  runtimeAccessToken: await mintRuntimeAccessToken({
    subject: "user_browser",
    orgId: "personal",
    workspaceId,
    // Same host-identity rule as `/__fixture/mint` above.
    hostId: access === "cloud" ? workspaceId : hostId,
    role,
    ttlSeconds: 120,
    jti: `fixture_${Date.now()}`,
    now: Date.now(),
  }, runtime.privateKey, "EdDSA"),
  role,
  workspaceDir,
  directory: workspaceDir,
  // Real, signed control-plane bearer token for `browserSubject` — see the
  // block above `authority = createSqliteWorkspaceAuthority()` for what
  // verifies it and why no current spec consumes this field yet.
  controlPlaneToken: browserControlPlaneToken,
  controlPlaneIssuer: jwksIssuer.issuer,
  desktopRefreshToken,
}))

async function shutdown() {
  server.close()
  await relay.close()
  stopAllUserHostedWorkspaceTunnels()
  await cloudRuntime?.close()
  await shutdownWorkspaceSupervisor()
  await opencode.close()
  await jwksIssuer.close()
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
}

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0))
})

process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0))
})

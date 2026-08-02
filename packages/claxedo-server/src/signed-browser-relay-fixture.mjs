import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile, spawn } from "node:child_process"
import { createServer } from "node:http"
import { promisify } from "node:util"
import { once } from "node:events"
import { serve } from "@hono/node-server"
import { exportJWK, generateKeyPair } from "jose"
import {
  mintHostTunnelToken,
  mintRuntimeAccessToken,
} from "@claxedo/workspace-relay"
import { createWorkspaceRuntimeApp } from "../../workspace-runtime/src/server.ts"
import { relayWorkspaceRuntimeExposure } from "../../workspace-runtime/src/exposure.ts"
import { createApp } from "./deployments/local/server"
import { opencodeRequest } from "./opencode/engine.ts"
import { createControlPlaneServices } from "./authority/services.ts"
import { createSqliteCentralStore } from "./authority/adapters/sqlite/central-store.ts"
import { configureWorkspaceSupervisor, createWorkspaceSupervisorSandboxManager, injectRuntime, shutdownWorkspaceSupervisor } from "./workspace/supervisor/supervisor.ts"
import { recordSupervisorSandboxLeaseReady } from "./adapters/sandbox/stores/sqlite-supervisor-state.ts"
import { ensureWorkspace, updateWorkspace } from "./workspace/store/index.ts"
import { startUserHostedWorkspaceTunnel, stopAllUserHostedWorkspaceTunnels, stopUserHostedWorkspaceTunnel } from "./user-hosted-tunnel.ts"

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

const workspaceRow = {
  workspace_id: workspaceId,
  project_id: projectId,
  backing: access === "cloud" ? "cloud-vm" : "local-worktree",
  access,
  // Real filesystem directory the embedded workspace-runtime actually serves —
  // `routes/bootstrap.ts`'s `signedBootstrapProjects()` reads `remote_directory` (falling
  // back to a fake "/workspace" placeholder when absent), and the client's
  // `sessionWorkspaceRuntimeRef` inventory match needs this to agree with the real
  // directory for the workspace to resolve consistently across the app.
  remote_directory: workspaceDir,
  display_name: access === "cloud" ? "Signed Cloud Relay" : "Signed Browser Relay",
  repo_name: "opencode",
  git_branch: "main",
}
const authConfig = {
  enabled: true,
  issuer: "https://clerk.e2e.test",
  jwksUrl: "https://clerk.e2e.test/.well-known/jwks.json",
}
const verifier = async (token, config) => ({
  mode: "signed",
  user: {
    subject: token,
    tokenIdentifier: `${config.issuer}|${token}`,
    issuer: config.issuer,
  },
})
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
  auth: {
    config: authConfig,
    verifier,
  },
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
services.authority = {
  usersMe: async () => ({ id: "user_browser" }),
  listOrgs: async () => [],
  resolveOrgId: async () => "personal",
  authorizeSessionRead: async () => {},
  authorizeWorkspaceOpen: async () => {},
  openWorkspace: async () => ({
    allowed: true,
    role,
    workspace: workspaceRow,
  }),
  listWorkspaces: async () => [workspaceRow],
  registerLocalForSharing: async () => workspaceRow,
  createLocalHostLinkChallenge: async () => ({
    challenge_id: "challenge_1",
    nonce: "nonce_1",
    expires_at: Date.now() + 60_000,
  }),
  registerLocalHostLink: async () => ({
    active: true,
    host_id: hostId,
    workspace_id: workspaceId,
    expires_at: Date.now() + 60_000,
    last_seen_at: Date.now(),
  }),
  heartbeatLocalHostLink: async () => ({
    active: true,
    host_id: hostId,
    workspace_id: workspaceId,
    expires_at: Date.now() + 60_000,
    last_seen_at: Date.now(),
  }),
  pauseLocalHostLink: async () => ({ workspace_id: workspaceId, paused: true, count: 1 }),
  activeLocalHostLink: async () => ({
    active: true,
    host_id: hostId,
    workspace_id: workspaceId,
    expires_at: Date.now() + 60_000,
    last_seen_at: Date.now(),
  }),
  deleteWorkspace: async () => ({}),
  createCloudWorkspace: async () => ({}),
  grantWorkspaceShare: async () => ({}),
  revokeWorkspaceShare: async () => ({}),
  listSessions: async () => [{
    session_id: "signed-browser-relay-session",
    workspace_id: workspaceId,
    project_id: projectId,
    directory: workspaceDir,
    title: access === "cloud" ? "Signed cloud relay session" : "Signed browser relay session",
    created_at: 1,
    updated_at: 2,
  }],
  readSessionMessages: async () => ({
    allowed: true,
    messages: sessionMessages,
  }),
  upsertSessionVisibility: async () => ({}),
  replaceSessionVisibility: async () => ({}),
  deleteSessionVisibility: async () => ({}),
  recordRuntimeAccessToken: async () => ({}),
  runtimeAccessTokenActive: async () => ({ active: true }),
  revokeRuntimeAccessToken: async () => ({}),
  revokeRuntimeAccessTokensForWorkspaceUser: async () => ({}),
  listWorkspaceAgentExtensions: async () => [],
  listWorkspaceAgentExtensionsForRuntime: async () => [],
  authorizeWorkspaceAgentExtensionsAdmin: async () => {},
  upsertWorkspaceAgentExtension: async () => ({}),
  setWorkspaceAgentExtensionEnabled: async () => ({}),
  deleteWorkspaceAgentExtension: async () => ({}),
  auditDeny: async () => {},
  auditAllow: async () => {},
}

const built = createApp(services)
built.app.get("/__fixture/opencode-requests", (c) => c.json({ requests: opencodeRequests }))

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
  fetch: built.app.fetch,
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
}))

async function shutdown() {
  server.close()
  await relay.close()
  stopAllUserHostedWorkspaceTunnels()
  await cloudRuntime?.close()
  await shutdownWorkspaceSupervisor()
  await opencode.close()
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
}

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0))
})

process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0))
})

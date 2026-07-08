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
import { createApp } from "./server.ts"
import { createControlPlaneServices } from "./control-plane/services.ts"
import { configureEmbeddedWorkspaceRuntime } from "./embedded-workspace-runtime.ts"
import { createSqliteCentralStore } from "./control-plane/adapters/sqlite/central-store.ts"
import { configureWorkspaceSupervisor, createWorkspaceSupervisorSandboxManager, injectRuntime, shutdownWorkspaceSupervisor } from "./workspace-supervisor.ts"
import { recordSupervisorSandboxLeaseReady } from "./sandbox-manager-adapters/stores/sqlite-supervisor-state.ts"
import { ensureWorkspace, updateWorkspace } from "./workspace-store.ts"
import { startUserHostedWorkspaceTunnel, stopAllUserHostedWorkspaceTunnels } from "./user-hosted-tunnel.ts"

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
    hostId,
  }
  const runtime = createWorkspaceRuntimeApp({
    exposure: relayWorkspaceRuntimeExposure(relayHostAuth),
    target: {
      workspaceId,
      directory: workspaceDir,
    },
    relayHostAuth,
    configToken: runtimeConfigToken,
    opencodeUrl: input.opencodeUrl,
  })
  const server = serve({
    fetch: runtime.app.fetch,
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
  return {
    url,
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
configureEmbeddedWorkspaceRuntime({ opencodeUrl: opencode.url })

configureWorkspaceSupervisor({
  server_url: backendUrl,
  opencode_url: opencode.url,
})

const workspace = await ensureWorkspace({
  workspaceId,
  project_id: projectId,
  directory: workspaceDir,
  kind: "local",
  workspace_name: "Signed Browser Relay",
})
if (!workspace) throw new Error("Signed browser relay workspace was not stored")

let effectiveWorkspace = workspace
if (access === "cloud") {
  cloudRuntime = await startCloudRuntime({
    relayHostPublicKey: relayHost.publicKey,
    opencodeUrl: opencode.url,
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
    tokenExpiresAt: now + 120_000,
    runtimeAccessToken: await mintRuntimeAccessToken({
      subject: input.subject,
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      hostId: input.hostId,
      role: input.role,
      ttlSeconds: 120,
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
    hostId,
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

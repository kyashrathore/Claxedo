/**
 * The `claxedo connect` Tier R lane: the signed relay fixture in its
 * `connect` host mode (no embedded host; real `claxedo connect` children;
 * the relay child wired to the control plane's resolver, revocation and
 * host-generation routes), the owner's `claxedo host …` CLI run from this
 * process as the owner's laptop, and typed wrappers over the fixture's
 * `/__fixture/connect/*`, fault and mint routes.
 */
import http from "node:http"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { stopChild as stopOwnedChild } from "./child-process"
import { claudeScriptedEnv, type ScriptedModelServer } from "./scripted-model-server"
import { REPO_ROOT, SERVER_DIR } from "./web-signed-relay-harness"

export const CLI_ENTRY = path.join(REPO_ROOT, "packages", "cli", "src", "index.ts")

/** The relay child's timing knobs, all in milliseconds; every bound a spec asserts derives from these. */
export type RelayTiming = {
  revocationCacheTtlMs: number
  hostGenerationCacheTtlMs: number
  targetCacheTtlMs: number
  clientCheckIntervalMs: number
  hostGenerationCheckIntervalMs: number
  /** Consecutive failed host-generation checks an established tunnel survives. */
  hostGenerationOutageGraceAttempts: number
}

export type ConnectFixtureInfo = {
  hostMode: "connect"
  backendUrl: string
  relayUrl: string
  orgId: string
  roots: { root: string; api: string; web: string; docs: string }
  resolverToken: string
  hostJwksUrl: string
  sessionAuthorityUrl: string
  controlPlaneToken: string
  controlPlaneIssuer: string
  ownerSubject: string
  ownerActor: { actor_id: string; actor_public_id: string; actor_name: string }
}

export type RunningConnectFixture = {
  info: ConnectFixtureInfo
  timing: RelayTiming
  log(): string
  close(): Promise<void>
}

const stopChild = (child: ChildProcess | undefined) => stopOwnedChild(child, { processGroup: true })

export async function startConnectHostFixture(opts: {
  backendPort: number
  scripted: ScriptedModelServer
  claudeConfigDir: string
  timing: RelayTiming
}): Promise<RunningConnectFixture> {
  let log = ""
  const child = spawn(
    "node",
    ["--conditions=development", "--import", "./src/text-imports.mjs", "--import", "tsx", "src/signed-browser-relay-fixture.mjs"],
    {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        CLAXEDO_E2E_BACKEND_PORT: String(opts.backendPort),
        CLAXEDO_E2E_RELAY_FIXTURE_HOST: "connect",
        CLAXEDO_RELAY_REVOCATION_CACHE_TTL_MS: String(opts.timing.revocationCacheTtlMs),
        CLAXEDO_RELAY_HOST_GENERATION_CACHE_TTL_MS: String(opts.timing.hostGenerationCacheTtlMs),
        CLAXEDO_RELAY_TARGET_CACHE_TTL_MS: String(opts.timing.targetCacheTtlMs),
        CLAXEDO_E2E_RELAY_CLIENT_CHECK_INTERVAL_MS: String(opts.timing.clientCheckIntervalMs),
        CLAXEDO_E2E_RELAY_HOST_GENERATION_CHECK_INTERVAL_MS: String(opts.timing.hostGenerationCheckIntervalMs),
        CLAXEDO_E2E_RELAY_HOST_GENERATION_OUTAGE_GRACE_ATTEMPTS: String(opts.timing.hostGenerationOutageGraceAttempts),
        ...opts.scripted.piEnv,
        CLAXEDO_E2E_SCRIPTED_MODEL_URL: opts.scripted.v1Url,
        ...claudeScriptedEnv(opts.scripted.url, opts.claudeConfigDir),
      },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    },
  )
  let info: ConnectFixtureInfo
  try {
    info = await new Promise<ConnectFixtureInfo>((resolve, reject) => {
      let settled = false
      let stdout = ""
      const finish = (error: Error) => {
        if (settled) return
        settled = true
        reject(error)
      }
      const timeout = setTimeout(() => finish(new Error(`GATING: connect host fixture did not start within 120s.\n${log}`)), 120_000)
      child.stdout?.on("data", (chunk) => {
        const text = chunk.toString()
        log += text
        stdout += text
        for (const line of stdout.split("\n")) {
          if (settled || !line.trim()) continue
          try {
            const parsed = JSON.parse(line) as ConnectFixtureInfo
            if (parsed.hostMode !== "connect" || !parsed.backendUrl || !parsed.relayUrl || !parsed.controlPlaneToken || !parsed.resolverToken || !parsed.roots?.api) continue
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
        finish(new Error(`GATING: connect host fixture exited before starting (${code ?? signal}).\n${log}`))
      })
      child.once("error", finish)
    })
  } catch (error) {
    await stopChild(child)
    throw error
  }
  return { info, timing: opts.timing, log: () => log, close: () => stopChild(child) }
}

export type CliResult = { code: number | null; stdout: string; stderr: string; output: string }

/**
 * `claxedo host …` exactly as the owner runs it on a signed-in laptop: the
 * CLI's source under node with the same loader recipe the fixture spawns its
 * own child with, `CLAXEDO_DEV_TOKEN` standing in for `claxedo login`, and a
 * private `CLAXEDO_HOME` so nothing of the owner's lands in a host's state.
 */
export async function ownerCli(fixture: RunningConnectFixture, args: string[], input: { home: string }): Promise<CliResult> {
  return await new Promise((resolve, reject) => {
    const child = execFile(
      "node",
      ["--conditions=development", "--import", "./src/text-imports.mjs", "--import", "tsx", CLI_ENTRY, ...args],
      {
        cwd: SERVER_DIR,
        env: {
          ...process.env,
          CLAXEDO_DEV_TOKEN: fixture.info.controlPlaneToken,
          CLAXEDO_CONTROL_PLANE_URL: fixture.info.backendUrl,
          CLAXEDO_HOME: input.home,
        },
        timeout: 60_000,
      },
      (error, stdout, stderr) => {
        if (error && child.exitCode === null && !("code" in error && typeof error.code === "number")) return reject(error)
        const code = child.exitCode ?? (error && "code" in error && typeof error.code === "number" ? error.code : 1)
        const clean = (text: string) => text.split("\n").filter((line) => !line.includes("DeprecationWarning") && !line.includes("--trace-deprecation")).join("\n")
        resolve({ code, stdout: clean(stdout), stderr: clean(stderr), output: `${clean(stdout)}\n${clean(stderr)}` })
      },
    )
  })
}

export async function ownerHome() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-connect-owner-"))
}

/** The one-line invitation token `claxedo host invite` prints once. */
export function invitationTokenFrom(output: string) {
  const token = output.split("\n").map((line) => line.trim()).find((line) => line.startsWith("chx_inv_1."))
  if (!token) throw new Error(`GATING: no invitation token in:\n${output}`)
  return token
}

export type Machine = { display_name: string; enrollment_id: string; host_id: string; serving_generation?: number; expires_at?: number; scope?: { allowed_roots: string[] } }

async function json<T>(response: Response, label: string): Promise<T> {
  const text = await response.text()
  if (!response.ok) throw new Error(`GATING: ${label} failed: ${response.status} ${text}`)
  return JSON.parse(text) as T
}

function owner(fixture: RunningConnectFixture, token = fixture.info.controlPlaneToken) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" }
}

export async function machines(fixture: RunningConnectFixture): Promise<Machine[]> {
  const body = await json<{ machines?: Machine[] }>(
    await fetch(`${fixture.info.backendUrl}/api/claxedo/host/enrollments`, { headers: owner(fixture) }),
    "list machines",
  )
  return body.machines ?? []
}

export type UserHostedWorkspace = { workspace_id: string; remote_directory?: string; host_online?: boolean; display_name?: string }

export async function userHostedWorkspaces(fixture: RunningConnectFixture, token?: string): Promise<UserHostedWorkspace[]> {
  const body = await json<{ workspaces: UserHostedWorkspace[] }>(
    await fetch(`${fixture.info.backendUrl}/api/workspace?access=user-hosted`, { headers: owner(fixture, token) }),
    "list user-hosted workspaces",
  )
  return body.workspaces
}

export type Connection = { relayUrl: string; runtimeAccessToken: string; role: string; hostId?: string }

/** The product mint, or the refusal it answers with when the workspace is not routable. */
export async function mintConnection(fixture: RunningConnectFixture, workspaceId: string, token?: string) {
  const response = await fetch(`${fixture.info.backendUrl}/api/workspace/${encodeURIComponent(workspaceId)}/connection`, {
    headers: owner(fixture, token),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  return { status: response.status, ok: response.ok, body: parsed as (Connection & { error?: { code?: string } }) | undefined, text }
}

export async function relayFetch(
  relayUrl: string,
  workspaceId: string,
  token: string,
  requestPath: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {},
) {
  const response = await fetch(`${relayUrl}/workspaces/${encodeURIComponent(workspaceId)}${requestPath}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  return { status: response.status, ok: response.ok, json: parsed as Record<string, unknown> | undefined, text }
}

export function errorCode(json: unknown): string | undefined {
  const error = (json as { error?: { code?: unknown } } | undefined)?.error
  return typeof error?.code === "string" ? error.code : undefined
}

/**
 * The relay's own view of the control plane's answers, asked with the same
 * resolver token the relay child uses. Uncached: this is what the relay
 * learns on its next cache miss.
 */
export async function relayTarget(fixture: RunningConnectFixture, workspaceId: string, hostId: string) {
  const url = new URL(`${fixture.info.backendUrl}/internal/relay/target`)
  url.searchParams.set("workspaceId", workspaceId)
  url.searchParams.set("hostId", hostId)
  const response = await fetch(url, { headers: { authorization: `Bearer ${fixture.info.resolverToken}` } })
  return { status: response.status, found: response.ok, body: await response.json().catch(() => undefined) as Record<string, unknown> | undefined }
}

export async function hostGeneration(fixture: RunningConnectFixture, enrollmentId: string) {
  const url = new URL(`${fixture.info.backendUrl}/internal/relay/host-generation`)
  url.searchParams.set("enrollmentId", enrollmentId)
  const response = await fetch(url, { headers: { authorization: `Bearer ${fixture.info.resolverToken}` } })
  return { status: response.status, body: await response.json().catch(() => undefined) as { generation?: number; revoked?: boolean } | undefined }
}

export type ConnectStatus = {
  id: string
  home: string
  pid: number | null
  running: boolean
  exit: { code: number | null; signal: string | null; at: number } | null
  state: {
    host_id: string
    control_plane_url: string
    enrollment?: { enrollment_id: string; key_version: number }
    bootstrap?: { invitation_id: string }
    run?: { pid: number; generation: number; last_beat_ok_at?: number; lease_expires_at?: number; last_beat_error?: string; served?: Array<{ workspace_id: string; revision: number; connected: boolean }> }
    scope?: { revision: number; allowed_roots: string[] }
  } | null
  log: string
}

export const connect = {
  async start(fixture: RunningConnectFixture, input: { id: string; token?: string; roots?: string[]; name?: string; cloneOf?: string }) {
    return await json<{ id: string; pid: number; home: string; stateFile: string }>(
      await fetch(`${fixture.info.backendUrl}/__fixture/connect/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }),
      `connect start ${input.id}`,
    )
  },
  async cloneState(fixture: RunningConnectFixture, from: string, to: string) {
    return await json<{ id: string; home: string }>(
      await fetch(`${fixture.info.backendUrl}/__fixture/connect/clone-state`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from, to }) }),
      `clone state ${from} -> ${to}`,
    )
  },
  async stop(fixture: RunningConnectFixture, id: string, timeoutMs = 30_000) {
    return await json<{ exit: ConnectStatus["exit"] }>(
      await fetch(`${fixture.info.backendUrl}/__fixture/connect/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, timeoutMs }) }),
      `connect stop ${id}`,
    )
  },
  async signal(fixture: RunningConnectFixture, id: string, signal: "SIGSTOP" | "SIGCONT") {
    return await json<{ id: string; signal: string }>(
      await fetch(`${fixture.info.backendUrl}/__fixture/connect/signal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, signal }) }),
      `connect ${signal} ${id}`,
    )
  },
  /** `acquire` with an instance's persisted key, no process: the cloned-disk claim on its own. */
  async acquire(fixture: RunningConnectFixture, id: string) {
    return await json<{ generation: number; generation_acquired_at: number }>(
      await fetch(`${fixture.info.backendUrl}/__fixture/connect/acquire`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }),
      `connect acquire ${id}`,
    )
  },
  async kill(fixture: RunningConnectFixture, id: string) {
    return await json<{ exit: ConnectStatus["exit"] }>(
      await fetch(`${fixture.info.backendUrl}/__fixture/connect/kill`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }),
      `connect kill ${id}`,
    )
  },
  async waitExit(fixture: RunningConnectFixture, id: string, timeoutMs: number) {
    return await json<{ exit: ConnectStatus["exit"] }>(
      await fetch(`${fixture.info.backendUrl}/__fixture/connect/wait-exit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, timeoutMs }) }),
      `connect wait-exit ${id}`,
    )
  },
  async status(fixture: RunningConnectFixture, id: string) {
    return await json<ConnectStatus>(await fetch(`${fixture.info.backendUrl}/__fixture/connect/status?id=${encodeURIComponent(id)}`), `connect status ${id}`)
  },
}

export const faults = {
  async redeemResponseDrop(fixture: RunningConnectFixture, on: boolean) {
    return await json<{ redeemResponseDrop: boolean; heldRedeems: number }>(
      await fetch(`${fixture.info.backendUrl}/__fixture/faults/redeem-response-drop?on=${on ? 1 : 0}`, { method: "POST" }),
      "redeem-response-drop",
    )
  },
  /** `resolver: true` also takes the relay's `/internal/relay/*` routes down — the whole control plane, from the relay's side. */
  async controlPlaneOutage(fixture: RunningConnectFixture, on: boolean, options: { resolver?: boolean } = {}) {
    return await json<{ controlPlaneOutage: boolean; resolverOutage: boolean }>(
      await fetch(`${fixture.info.backendUrl}/__fixture/faults/control-plane-outage?on=${on ? 1 : 0}&resolver=${options.resolver ? 1 : 0}`, { method: "POST" }),
      "control-plane-outage",
    )
  },
  async state(fixture: RunningConnectFixture) {
    return await json<{ redeemResponseDrop: boolean; controlPlaneOutage: boolean; heldRedeems: number }>(
      await fetch(`${fixture.info.backendUrl}/__fixture/faults`),
      "faults",
    )
  },
}

export type Teammate = { subject: string; tokenIdentifier: string; role: string; controlPlaneToken: string; name?: string }

export async function teammate(fixture: RunningConnectFixture, input: { subject: string; role: "viewer" | "editor"; name: string; workspaceId: string }) {
  const url = new URL(`${fixture.info.backendUrl}/__fixture/authority-identity`)
  url.searchParams.set("subject", input.subject)
  url.searchParams.set("role", input.role)
  url.searchParams.set("name", input.name)
  url.searchParams.set("workspaceId", input.workspaceId)
  return await json<Teammate>(await fetch(url), `teammate ${input.subject}`)
}

export async function mintRht(fixture: RunningConnectFixture, input: { role: "viewer" | "editor"; workspaceId: string; hostId: string; subject: string }) {
  const url = new URL(`${fixture.info.backendUrl}/__fixture/mint-rht`)
  for (const [key, value] of Object.entries(input)) url.searchParams.set(key, value)
  return await json<{ relayHostToken: string; runtimeAccessToken: string; parentJti: string }>(await fetch(url), "mint-rht")
}

export async function mintHtt(fixture: RunningConnectFixture, input: { enrollmentId: string; hostId: string; workspaceId: string; generation: number }) {
  const url = new URL(`${fixture.info.backendUrl}/__fixture/mint-htt`)
  for (const [key, value] of Object.entries(input)) url.searchParams.set(key, String(value))
  return await json<{ hostTunnelToken: string }>(await fetch(url), "mint-htt")
}

export async function tunnelDeliver(
  fixture: RunningConnectFixture,
  input: { instance: string; workspaceId: string; relayHostToken: string; method: string; path: string; body?: unknown; headers?: Record<string, string> },
) {
  return await json<{ status: number; json?: Record<string, unknown>; text: string; localBaseUrl: string }>(
    await fetch(`${fixture.info.backendUrl}/__fixture/tunnel/deliver`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }),
    "tunnel deliver",
  )
}

export type RelayAuditEvent = { at: number; action: string; result: "allow" | "deny"; reason?: string; workspaceId?: string; hostId?: string; path: string }

export async function relayAudit(fixture: RunningConnectFixture, since = 0) {
  const body = await json<{ events: RelayAuditEvent[] }>(await fetch(`${fixture.info.relayUrl}/__fixture/audit?since=${since}`), "relay audit")
  return body.events
}

export async function relayHostPresence(fixture: RunningConnectFixture, hostId: string, workspaceId: string) {
  const url = new URL(`${fixture.info.relayUrl}/__fixture/host`)
  url.searchParams.set("hostId", hostId)
  url.searchParams.set("workspaceId", workspaceId)
  return await json<{ active: boolean; presence: { connectedAt: number; lastPongAt: number } | null }>(await fetch(url), "relay host presence")
}

/**
 * A host-tunnel registration attempt with a given Host Tunnel Token: the
 * upgrade request the host would send, answered by the relay before any
 * socket exists. The relay refuses with a JSON status, so the HTTP answer is
 * the whole result; a 101 would mean it was admitted, which a spec never
 * wants for a token it is only probing.
 */
export function hostTunnelAdmission(relayUrl: string, hostId: string, workspaceId: string, hostTunnelToken: string) {
  const url = new URL(`${relayUrl}/host-tunnels/${encodeURIComponent(hostId)}`)
  url.searchParams.set("workspaceId", workspaceId)
  return new Promise<{ status: number; body: string; code?: string }>((resolve, reject) => {
    const request = http.request(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${hostTunnelToken}`,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": Buffer.from(String(Math.random())).toString("base64").slice(0, 24),
      },
    })
    request.on("upgrade", (response, socket) => {
      socket.destroy()
      resolve({ status: 101, body: "" })
    })
    request.on("response", (response) => {
      let body = ""
      response.on("data", (chunk) => (body += chunk.toString()))
      response.on("end", () => {
        let code: string | undefined
        try {
          code = errorCode(JSON.parse(body))
        } catch {
          code = undefined
        }
        resolve({ status: response.statusCode ?? 0, body, ...(code ? { code } : {}) })
      })
    })
    request.on("error", reject)
    request.end()
  })
}

/**
 * An open SSE stream over the relay, read until the server ends it. `closed`
 * resolves with the moment the stream ended (or the moment it was refused,
 * with the status), which is what a "closes by the next check" bound reads.
 */
export async function openEventStream(relayUrl: string, workspaceId: string, token: string, sessionId: string) {
  const controller = new AbortController()
  const url = `${relayUrl}/workspaces/${encodeURIComponent(workspaceId)}/api/wr/events?sessionID=${encodeURIComponent(sessionId)}`
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal: controller.signal })
  const openedAt = Date.now()
  const chunks: string[] = []
  const closed = (async () => {
    if (!response.ok || !response.body) return { status: response.status, closedAt: Date.now(), body: await response.text().catch(() => "") }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(decoder.decode(value))
      }
    } catch {
      // The socket ending underneath the reader is the close this reports.
    }
    return { status: response.status, closedAt: Date.now(), body: chunks.join("") }
  })()
  return { status: response.status, openedAt, closed, abort: () => controller.abort(), received: () => chunks.join("") }
}

/**
 * Polls until `probe` returns a value. `since` is the moment of the action
 * whose consequence is awaited (an assignment, a revoke); the deadline and
 * the reported `elapsedMs` both count from it, so observations made between
 * the action and this call do not widen the bound. The message names what
 * never happened.
 */
export async function until<T>(
  probe: () => Promise<T | undefined | false>,
  options: { since: number; timeoutMs: number; intervalMs?: number; message: string },
): Promise<{ value: T; elapsedMs: number }> {
  let last: unknown
  for (;;) {
    try {
      const value = await probe()
      if (value !== undefined && value !== false) return { value: value as T, elapsedMs: Date.now() - options.since }
      last = value
    } catch (error) {
      last = error
    }
    if (Date.now() - options.since > options.timeoutMs) {
      throw new Error(`${options.message} (waited ${Date.now() - options.since}ms from the action; last: ${last instanceof Error ? last.message : JSON.stringify(last)})`)
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 500))
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

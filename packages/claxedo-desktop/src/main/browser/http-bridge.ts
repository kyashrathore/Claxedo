/**
 * Local HTTP bridge between the claxedo-mcp subprocess and the Electron main
 * process's `BrowserRegistry` / `BrowserHandle` instances.
 *
 * The MCP subprocess is stdio-only; it has no Electron IPC surface. It needs
 * a way to ask the main process for screenshots, console logs, and evaluate
 * results. This bridge is that surface: a `node:http` listener bound to
 * `127.0.0.1` on an ephemeral port, with a per-launch shared secret.
 *
 * Threat model (enforced by `authenticate()` + CSRF guard):
 *
 *   1. Any process on the box can connect to `127.0.0.1:<port>`. Mitigation:
 *      per-launch UUID token required in the `x-claxedo-desktop-token` custom
 *      header. Browsers cannot set custom headers on cross-origin `fetch`
 *      without a CORS preflight, which this bridge never grants — so a
 *      malicious webpage the user visits in their real browser cannot reach
 *      these routes even if it knows the port.
 *
 *   2. Token is one-call-scoped but browser-unreachable. No cookie auth,
 *      ever. Token is not persisted; a desktop relaunch invalidates it.
 *
 *   3. `Origin:` allowlist rejects anything other than the MCP-synthetic
 *      origin (`DESKTOP_MCP_ORIGIN`) or a missing `Origin` (stdio clients,
 *      tests). This is redundant with the custom-header defense but costs
 *      nothing and closes simulator edge cases.
 *
 *   4. GETs are read-only. Any state-mutating action (navigate, evaluate,
 *      screenshot) is a POST. A GET to a POST-only route returns 405. This
 *      guarantees that even if a browser somehow spoofed the header and the
 *      origin, a `<img src>` / `<form action>` / navigation-based CSRF cannot
 *      mutate state.
 *
 *   5. Every agent-initiated screenshot / evaluate / navigate is appended to
 *      the shared `agent-audit-log` so the bound session can surface
 *      "agent performed X on tab Y" entries. Screenshot responses enforce a
 *      hard 1 MB ceiling (tighter than the handle's own cap chain) — if the
 *      handle returns a larger image the bridge refuses rather than serving.
 *
 * The bridge is constructed with a small dependency bag rather than reaching
 * into globals so unit tests can inject a fake registry + fake audit log
 * without spinning up Electron.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"

import type { AgentAuditLog } from "./agent-audit-log"
import { agentAuditLog as defaultAgentAuditLog } from "./agent-audit-log"
import type { BrowserHandle } from "./handle"
import type { BrowserRegistry } from "./registry"
import { DESKTOP_MCP_ORIGIN, DESKTOP_TOKEN_HEADER, ensureDesktopToken, setDesktopUrl } from "./token"

const BIND_HOST = "127.0.0.1"
const MAX_RESPONSE_IMAGE_BYTES = 1_000_000
const MAX_REQUEST_BODY_BYTES = 256 * 1024

export type BridgeTabSummary = {
  paneId: string
  title: string
  currentUrl: string
  groupId?: string
  agentAllowed: boolean
}

export type BridgeDeps = {
  registry: BrowserRegistry
  auditLog?: AgentAuditLog
  /** Optional resolver for the renderer-visible `groupId`. Unit 4 leaves it
   * unwired (returns undefined) — later units can plumb it through from the
   * pane-registration IPC payload. */
  getGroupId?: (paneId: string) => string | undefined
  /**
   * Fallback title resolver for tests that can't provide a real
   * `WebContents`. Called with the paneId when `handle.webContents.getTitle`
   * cannot be invoked.
   */
  resolveTitle?: (paneId: string, handle: BrowserHandle) => string
}

export type BridgeHandle = {
  url: string
  port: number
  token: string
  close: () => Promise<void>
}

export async function startDesktopHttpBridge(deps: BridgeDeps): Promise<BridgeHandle> {
  const token = ensureDesktopToken()
  const auditLog = deps.auditLog ?? defaultAgentAuditLog

  const server = createServer((req, res) => {
    handleRequest(req, res, deps, auditLog, token).catch((err) => {
      sendJson(res, 500, { error: "internal", message: String(err instanceof Error ? err.message : err) })
    })
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, BIND_HOST, () => {
      const address = server.address()
      if (!address || typeof address !== "object") {
        reject(new Error("bridge: failed to bind ephemeral port"))
        return
      }
      resolve(address.port)
    })
  })

  const url = `http://${BIND_HOST}:${port}`
  setDesktopUrl(url)

  return {
    url,
    port,
    token,
    close: () => closeServer(server),
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: BridgeDeps,
  auditLog: AgentAuditLog,
  token: string,
): Promise<void> {
  // Auth + CSRF before anything else — never let an unauthenticated caller
  // observe the route table shape.
  const authFailure = authenticate(req, token)
  if (authFailure) {
    sendJson(res, authFailure.status, { error: authFailure.error })
    return
  }

  const { pathname } = parseUrl(req.url ?? "/")
  const method = (req.method ?? "GET").toUpperCase()

  // Route: GET /browser/tabs — read-only list
  if (pathname === "/browser/tabs") {
    if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" })
    return sendJson(res, 200, { tabs: enumerateTabs(deps) })
  }

  // Routes: /browser/:paneId/...
  const paneMatch = pathname.match(/^\/browser\/([^/]+)\/([a-z-]+)$/)
  if (!paneMatch) {
    sendJson(res, 404, { error: "not-found" })
    return
  }
  const paneId = decodeURIComponent(paneMatch[1] ?? "")
  const action = paneMatch[2] ?? ""
  const handle = deps.registry.get(paneId)
  if (!handle) {
    sendJson(res, 404, { error: "pane-not-found", paneId })
    return
  }

  switch (action) {
    case "console": {
      // GET-only (read-only observation of the ring buffer).
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" })
      const url = new URL(req.url ?? "/", `http://${BIND_HOST}`)
      const query: Record<string, unknown> = {}
      const since = url.searchParams.get("since")
      const limit = url.searchParams.get("limit")
      const level = url.searchParams.get("level")
      if (since !== null && since !== "") {
        const n = Number.parseInt(since, 10)
        if (Number.isFinite(n)) query.since = n
      }
      if (limit !== null && limit !== "") {
        const n = Number.parseInt(limit, 10)
        if (Number.isFinite(n)) query.limit = n
      }
      if (level) query.level = level
      const entries = handle.getConsoleLogs(query as Parameters<BrowserHandle["getConsoleLogs"]>[0])
      return sendJson(res, 200, { entries })
    }

    case "screenshot": {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" })
      const body = await readJson(req)
      if (body.error) return sendJson(res, 400, { error: body.error })
      const opts = (body.value ?? {}) as { clip?: { x: number; y: number; width: number; height: number; scale?: number } }
      const result = await handle.screenshot({ clip: opts.clip })
      if (!result.ok) {
        auditLog.append({
          paneId,
          action: "screenshot",
          summary: describeScreenshot(opts),
          result: "denied",
          reason: result.error.code,
        })
        return sendJson(res, 200, result)
      }
      // Enforce bridge-side size cap — belt-and-braces with the handle's own
      // cap ladder. Refuse outright rather than truncate, so the MCP tool can
      // return a structured error to the agent.
      const sizeBytes = approxDataUrlBytes(result.dataUrl)
      if (sizeBytes > MAX_RESPONSE_IMAGE_BYTES) {
        auditLog.append({
          paneId,
          action: "screenshot",
          summary: describeScreenshot(opts),
          result: "denied",
          reason: "image-too-large",
        })
        return sendJson(res, 200, {
          ok: false,
          error: { code: "too-large", message: `screenshot exceeds ${MAX_RESPONSE_IMAGE_BYTES} byte cap` },
        })
      }
      auditLog.append({
        paneId,
        action: "screenshot",
        summary: describeScreenshot(opts),
        result: "allowed",
      })
      return sendJson(res, 200, result)
    }

    case "evaluate": {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" })
      const body = await readJson(req)
      if (body.error) return sendJson(res, 400, { error: body.error })
      const value = body.value as { expression?: string } | null
      const expression = typeof value?.expression === "string" ? value.expression : ""
      if (!expression) return sendJson(res, 400, { error: "expression-required" })
      const summary = `eval (${expression.length} chars)`
      const result = await handle.evaluate(expression)
      // BrowserHandle.evaluate already audits denials; we mirror the
      // allowed/denied record here via the bridge's audit log so the
      // bound-session system-message render has a stable source.
      if (!result.ok) {
        auditLog.append({
          paneId,
          action: "evaluate",
          summary,
          result: "denied",
          reason: result.error.code,
        })
        return sendJson(res, 200, result)
      }
      auditLog.append({ paneId, action: "evaluate", summary, result: "allowed" })
      return sendJson(res, 200, result)
    }

    case "navigate": {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" })
      const body = await readJson(req)
      if (body.error) return sendJson(res, 400, { error: body.error })
      const value = body.value as { url?: string } | null
      const target = typeof value?.url === "string" ? value.url.trim() : ""
      if (!target) return sendJson(res, 400, { error: "url-required" })
      try {
        const parsed = new URL(target)
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          auditLog.append({
            paneId,
            action: "navigate",
            summary: target,
            result: "denied",
            reason: `scheme ${parsed.protocol} not allowed`,
          })
          return sendJson(res, 200, {
            ok: false,
            error: { code: "bad-scheme", message: `scheme ${parsed.protocol} not allowed` },
          })
        }
      } catch {
        auditLog.append({ paneId, action: "navigate", summary: target, result: "denied", reason: "invalid-url" })
        return sendJson(res, 200, { ok: false, error: { code: "invalid-url", message: `invalid url: ${target}` } })
      }
      try {
        await handle.navigate(target)
        auditLog.append({ paneId, action: "navigate", summary: target, result: "allowed" })
        return sendJson(res, 200, { ok: true })
      } catch (err) {
        const message = String(err instanceof Error ? err.message : err)
        auditLog.append({ paneId, action: "navigate", summary: target, result: "denied", reason: message })
        return sendJson(res, 200, { ok: false, error: { code: "nav-failed", message } })
      }
    }

    case "audit": {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" })
      // Read the per-pane audit log slice. Sessions render these as system
      // messages; exposing the slice as a stable read lets UI polls and tests
      // both observe the same stream without accessing main-process globals.
      return sendJson(res, 200, { entries: auditLog.forPane(paneId) })
    }

    default:
      return sendJson(res, 404, { error: "not-found" })
  }
}

function enumerateTabs(deps: BridgeDeps): BridgeTabSummary[] {
  const ids = deps.registry.paneIds()
  const out: BridgeTabSummary[] = []
  for (const paneId of ids) {
    const handle = deps.registry.get(paneId)
    if (!handle) continue
    let currentUrl = ""
    let title = ""
    try {
      // `handle.webContents` is cast to the full Electron `WebContents` type;
      // all of `getURL`, `getTitle` exist at runtime. Tests can inject
      // `resolveTitle` to sidestep a missing stub.
      const wc = handle.webContents as unknown as { getURL?: () => string; getTitle?: () => string }
      currentUrl = wc.getURL ? wc.getURL() : ""
      title = wc.getTitle ? wc.getTitle() : ""
    } catch {
      // getURL / getTitle throw if the webContents has been destroyed.
    }
    if (!title && deps.resolveTitle) {
      title = deps.resolveTitle(paneId, handle)
    }
    out.push({
      paneId,
      title: title || "",
      currentUrl,
      groupId: deps.getGroupId?.(paneId),
      agentAllowed: handle.agentAllowed,
    })
  }
  return out
}

// ─── Auth + CSRF ────────────────────────────────────────────────────────────

type AuthFailure = { status: 401 | 403; error: string }

function authenticate(req: IncomingMessage, token: string): AuthFailure | undefined {
  const header = lowercaseHeader(req, DESKTOP_TOKEN_HEADER)
  if (!header) return { status: 401, error: "missing-token" }
  // Constant-time-ish compare — node http is not a high-throughput target
  // but we still avoid early-exit string comparison.
  if (header.length !== token.length) return { status: 401, error: "bad-token" }
  let diff = 0
  for (let i = 0; i < header.length; i++) {
    diff |= header.charCodeAt(i) ^ token.charCodeAt(i)
  }
  if (diff !== 0) return { status: 401, error: "bad-token" }

  // Origin check: accept MCP-synthetic origin OR no origin at all. A real
  // cross-origin browser fetch would carry a `https://foo.com` origin and
  // would still require CORS preflight to set our custom header — but we
  // belt-and-braces this anyway so the test suite can assert on the rejection.
  const origin = lowercaseHeader(req, "origin")
  if (origin !== undefined && origin !== "" && origin !== "null" && origin !== DESKTOP_MCP_ORIGIN) {
    return { status: 403, error: "bad-origin" }
  }

  return undefined
}

function lowercaseHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name]
  if (Array.isArray(raw)) return raw[0]
  return raw
}

// ─── Request/response helpers ───────────────────────────────────────────────

function parseUrl(raw: string): { pathname: string } {
  const base = `http://${BIND_HOST}`
  try {
    const u = new URL(raw, base)
    return { pathname: u.pathname }
  } catch {
    return { pathname: raw.split("?")[0] ?? "/" }
  }
}

async function readJson(req: IncomingMessage): Promise<{ value?: unknown; error?: string }> {
  const chunks: Buffer[] = []
  let total = 0
  let overflowed = false
  // Important: drain the whole request body even when we know it's too large.
  // Returning early from inside `for await (const chunk of req)` leaves the
  // Node HTTP socket state machine mid-request and silently drops the
  // corresponding response (verified empirically with a raw-TCP probe against
  // the server). Setting a flag and continuing to consume is the idiomatic
  // fix.
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer
      total += buf.length
      if (total > MAX_REQUEST_BODY_BYTES) {
        overflowed = true
        chunks.length = 0
        continue
      }
      if (!overflowed) chunks.push(buf)
    }
  } catch {
    return { error: "read-error" }
  }
  if (overflowed) return { error: "payload-too-large" }
  if (total === 0) return { value: null }
  const text = Buffer.concat(chunks).toString("utf8")
  try {
    return { value: JSON.parse(text) }
  } catch {
    return { error: "invalid-json" }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  if (!res.headersSent) {
    res.statusCode = status
    res.setHeader("Content-Type", "application/json; charset=utf-8")
    res.setHeader("Cache-Control", "no-store")
  }
  res.end(payload)
}

function approxDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",")
  if (comma === -1) return dataUrl.length
  const base64 = dataUrl.slice(comma + 1)
  return Math.floor((base64.length * 3) / 4)
}

function describeScreenshot(opts: { clip?: { x: number; y: number; width: number; height: number; scale?: number } }): string {
  if (opts.clip) {
    const { x, y, width, height } = opts.clip
    return `screenshot clip=${Math.round(x)},${Math.round(y)} ${Math.round(width)}x${Math.round(height)}`
  }
  return "screenshot (viewport)"
}

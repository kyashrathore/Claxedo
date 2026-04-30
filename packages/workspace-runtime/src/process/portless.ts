/**
 * Portless integration for named process URLs.
 *
 * When the user has Portless installed and the proxy is running, Claxedo registers
 * each process's `port.name` as a Portless route, surfacing a stable named URL like
 * `https://web.myapp.localhost`. When Portless is absent, every code path no-ops and
 * the existing `localhost:port` URL keeps working.
 *
 * Detection is per-process-start (cheap fs reads), no caching, no proxy supervision.
 *
 * Boundary rule: every call into the `portless` library is wrapped here. Callers
 * should never `import` `RouteStore`/`formatUrl` directly so a misbehaving Portless
 * version cannot escape and block process startup.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { RouteConflictError, RouteStore, formatUrl as portlessFormatUrl } from "portless"
import { Log } from "../log"
import type { Process } from "./process"

const log = Log.create({ service: "portless" })

const PORTLESS_DIR = path.join(os.homedir(), ".portless")
const DEFAULT_TLD = "localhost"

export interface ProxyState {
  stateDir: string
  proxyPort: number
  proxyPid: number
  tls: boolean
  tld: string
}

/**
 * Lowercase, replace invalid hostname-label characters with `-`, collapse runs,
 * trim leading/trailing `-`. Matches Portless's `sanitizeForHostname` behavior
 * but kept local so we don't depend on `auto.ts` (not in public exports).
 */
export function sanitize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function readNum(filePath: string): number | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8").trim()
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

function readStr(filePath: string): string | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8").trim()
    return raw || null
  } catch {
    return null
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Detect a running Portless proxy. Returns `null` when:
 * - `CLAXEDO_DISABLE_PORTLESS=1` is set
 * - the state dir doesn't exist
 * - any required state file is missing or unparseable
 * - the recorded proxy PID is not alive
 *
 * No exceptions ever escape — failure is silent and named URLs simply don't appear.
 *
 * `stateDir` defaults to `~/.portless` and only changes for tests.
 */
export function detectProxy(stateDir: string = PORTLESS_DIR): ProxyState | null {
  if (process.env.CLAXEDO_DISABLE_PORTLESS === "1") return null

  try {
    const proxyPort = readNum(path.join(stateDir, "proxy.port"))
    const proxyPid = readNum(path.join(stateDir, "proxy.pid"))
    if (proxyPort === null || proxyPid === null) return null
    if (!isAlive(proxyPid)) return null

    const tls = fs.existsSync(path.join(stateDir, "tls"))
    const tld = readStr(path.join(stateDir, "tld")) || DEFAULT_TLD

    return { stateDir, proxyPort, proxyPid, tls, tld }
  } catch (err) {
    log.warn("portless detect failed", { err: String(err) })
    return null
  }
}

/**
 * Construct a Portless RouteStore in a way that cannot escape into the launch path.
 * Today the constructor just joins paths, but a future Portless version that does
 * I/O at construction time (e.g. `ensureDir`) must not bring down `start()`.
 */
export function openStore(stateDir: string): RouteStore | null {
  try {
    return new RouteStore(stateDir)
  } catch (err) {
    log.warn("portless openStore failed", { stateDir, err: String(err) })
    return null
  }
}

/**
 * Format a Portless URL via the library's `formatUrl`, returning `null` on any throw.
 * Today `formatUrl` is pure string formatting, but wrapping keeps the boundary
 * invariant ("library exceptions never escape") consistent across versions.
 */
export function safeFormatUrl(hostname: string, proxyPort: number, tls: boolean): string | null {
  try {
    return portlessFormatUrl(hostname, proxyPort, tls)
  } catch (err) {
    log.warn("portless formatUrl failed", { hostname, proxyPort, err: String(err) })
    return null
  }
}

export interface DeriveHostnameInput {
  portName: string
  workspaceName: string | undefined
  workspaceId: string | undefined
  tld: string
  /** When true, append `-${workspaceId.slice(0,6)}` to the workspace label for collision resolution. */
  withDiscriminator?: boolean
}

/**
 * Compose `${port.name}.${workspace}.${tld}`. Returns `null` when the workspace label
 * cannot be derived (no workspaceName and no workspaceId for the discriminator path).
 *
 * The caller passes the already-resolved workspace name (from the fallback chain
 * workspace_name || project_name || repo_name || basename(directory)), so this
 * function only owns sanitization and discriminator append.
 */
export function deriveHostname(input: DeriveHostnameInput): string | null {
  const namePart = sanitize(input.portName)
  if (!namePart) return null

  let wsLabel = input.workspaceName ? sanitize(input.workspaceName) : ""
  if (input.withDiscriminator) {
    if (!input.workspaceId) return null
    const disc = sanitize(input.workspaceId).slice(0, 6)
    if (!disc) return null
    wsLabel = wsLabel ? `${wsLabel}-${disc}` : disc
  }
  if (!wsLabel) return null

  return `${namePart}.${wsLabel}.${input.tld}`
}

export interface DryRunHit {
  hostname: string
  pid: number
}

/**
 * Check whether a route already exists for `hostname` and is owned by a live PID.
 * Returns `null` when the route is free or only held by a dead PID. The Portless
 * RouteStore filters dead PIDs on read, so we only need to inspect the alive set.
 */
export function dryRunCheck(routeStore: { loadRoutes: () => Array<{ hostname: string; pid: number }> }, hostname: string): DryRunHit | null {
  try {
    const routes = routeStore.loadRoutes()
    const hit = routes.find((r) => r.hostname === hostname)
    if (!hit) return null
    return { hostname: hit.hostname, pid: hit.pid }
  } catch (err) {
    log.warn("portless dryRunCheck failed", { hostname, err: String(err) })
    return null
  }
}

export type RegisterResult =
  | { ok: true }
  | { ok: false; kind: "conflict"; hostname: string; pid: number }
  | { ok: false; kind: "error"; message: string }

/**
 * Register a route. Wraps `RouteStore.addRoute` and converts:
 * - `RouteConflictError` → `{ ok: false, kind: "conflict", ... }`
 * - any other thrown error → `{ ok: false, kind: "error", ... }`
 *
 * The published Portless `addRoute` returns `void`. With `force = true` it suppresses
 * the conflict check and overwrites the existing route entry, but it does NOT signal
 * the conflicting process — Claxedo callers that need a kill must do it themselves.
 */
export function tryRegister(
  routeStore: { addRoute: (hostname: string, port: number, pid: number, force?: boolean) => unknown },
  hostname: string,
  port: number,
  pid: number,
  force: boolean,
): RegisterResult {
  try {
    routeStore.addRoute(hostname, port, pid, force)
    return { ok: true }
  } catch (err: unknown) {
    if (err instanceof RouteConflictError) {
      return { ok: false, kind: "conflict", hostname: err.hostname, pid: err.existingPid }
    }
    const message = err instanceof Error ? err.message : String(err)
    log.warn("portless tryRegister failed", { hostname, port, err: message })
    return { ok: false, kind: "error", message }
  }
}

/**
 * Build a RouteConflictInfo populated with the conflicting hostname/pid.
 * Caller may augment with sibling-workspace info via cross-reference.
 */
export function makeRouteConflictInfo(hostname: string, pid: number): Process.RouteConflictInfo {
  return {
    type: "route-conflict",
    hostname,
    pid,
  }
}

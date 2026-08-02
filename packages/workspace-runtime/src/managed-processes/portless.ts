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

import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { RouteConflictError, RouteStore, formatUrl as portlessFormatUrl } from "portless"
import { Log } from "../log"
import type { Process } from "./schema"

const log = Log.create({ service: "portless" })

const PORTLESS_DIR = path.join(os.homedir(), ".portless")
const DEFAULT_TLD = "localhost"

/**
 * Hex characters of the sha256 digest kept as a workspace-id discriminator.
 * 10 hex chars = 40 bits of digest space: a birthday-bound collision chance
 * of ~1e-9 for a batch of 100 concurrently-live workspaces (100^2 / 2^41),
 * and still negligible (~1e-4) even at 10,000 concurrent workspaces — while
 * costing only 10 of the 63 characters in the DNS label budget below.
 * Matches the short-discriminator convention already used elsewhere in this
 * codebase for the same kind of human-facing collision disambiguation (see
 * `claxedo-server/src/credentials/discovery.ts`'s `.digest("hex").slice(0, 10)`).
 */
const DISCRIMINATOR_HEX_LEN = 10

/**
 * DNS label length ceiling (RFC 1035 3.1: labels are at most 63 octets).
 * `wsLabel` in `deriveHostname` is always a single label — `sanitize()`
 * never emits a `.` — so this bounds it directly, not just the composed
 * hostname.
 */
const DNS_LABEL_MAX_LEN = 63

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
 * - `WORKSPACE_RUNTIME_DISABLE_PORTLESS=1` is set
 * - the state dir doesn't exist
 * - any required state file is missing or unparseable
 * - the recorded proxy PID is not alive
 *
 * No exceptions ever escape — failure is silent and named URLs simply don't appear.
 *
 * `stateDir` defaults to `~/.portless` and only changes for tests.
 */
export function detectProxy(stateDir: string = PORTLESS_DIR): ProxyState | null {
  if (process.env.WORKSPACE_RUNTIME_DISABLE_PORTLESS === "1") return null

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
  /** When true, append a `workspaceId`-derived discriminator (see `deriveHostname`) to the workspace label for collision resolution. */
  withDiscriminator?: boolean
}

/**
 * Derive a short, deterministic, DNS-label-safe discriminator from a whole
 * workspace id.
 *
 * Hashes the *entire* id rather than reading characters at a fixed offset.
 * The previous implementation took `sanitize(workspaceId).slice(0, 6)`, which
 * for the `ws_<base36 millis>_<random>` id format is almost entirely the
 * slow-moving timestamp prefix — every id minted within the same ~46-hour
 * window produced the identical discriminator, defeating the one job this
 * value has. A digest mixes every character of the id, including whatever
 * high-entropy part a future id format carries and wherever it puts it, so
 * this keeps discriminating through the next id-format change without this
 * function ever needing to know where the "random part" lives.
 *
 * Deterministic by construction (sha256, no randomness involved): the same
 * workspace id always yields the same discriminator, in this process or a
 * different one, today or after a restart — required, since the result is
 * embedded in a hostname other processes route by.
 */
function discriminatorFor(workspaceId: string): string {
  return createHash("sha256").update(workspaceId).digest("hex").slice(0, DISCRIMINATOR_HEX_LEN)
}

/**
 * Truncate a label component to `maxLen`, stripping any trailing hyphen the
 * cut point exposes. `sanitize()` already guarantees no leading/trailing
 * hyphen and no hyphen runs on the *untruncated* string, but slicing at an
 * arbitrary index can still land right after one (e.g. `"foo-bar".slice(0, 4) === "foo-"`).
 */
function clampLabel(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value
  return value.slice(0, maxLen).replace(/-+$/, "")
}

/**
 * Compose `${port.name}.${workspace}.${tld}`. Returns `null` when the workspace label
 * cannot be derived (no workspaceName and no workspaceId for the discriminator path).
 *
 * The caller passes the already-resolved workspace name (from the fallback chain
 * workspace_name || project_name || repo_name || basename(directory)), so this
 * function only owns sanitization and discriminator append.
 *
 * `wsLabel` is a single DNS label, so it alone is kept within
 * `DNS_LABEL_MAX_LEN`. The discriminator (fixed length) is always kept in
 * full — it's the part actually doing disambiguation — and the
 * workspace-name part is truncated first when the two together would run
 * over budget.
 */
export function deriveHostname(input: DeriveHostnameInput): string | null {
  const namePart = sanitize(input.portName)
  if (!namePart) return null

  const sanitizedWorkspaceName = input.workspaceName ? sanitize(input.workspaceName) : ""

  let wsLabel: string
  if (input.withDiscriminator) {
    if (!input.workspaceId) return null
    const disc = discriminatorFor(input.workspaceId)
    const nameBudget = Math.max(0, DNS_LABEL_MAX_LEN - disc.length - 1) // "-" separator
    const clampedName = sanitizedWorkspaceName ? clampLabel(sanitizedWorkspaceName, nameBudget) : ""
    wsLabel = clampedName ? `${clampedName}-${disc}` : disc
  } else {
    wsLabel = clampLabel(sanitizedWorkspaceName, DNS_LABEL_MAX_LEN)
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

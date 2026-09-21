/**
 * The one file a `claxedo connect` host keeps.
 *
 * Identity, enrollment, endpoints, scope and the run record live together so
 * they cannot drift apart: a key paired with the wrong enrollment id fails at
 * the control plane as a signature denial that points at nothing. The file is
 * the recovery story too — the key is persisted BEFORE the first redeem, so a
 * redeem whose response was lost is recovered by redeeming again with the same
 * key, and `bootstrap` staying set across a crash tells the next boot what
 * cleanup was interrupted.
 *
 * Node's fs is injected rather than imported: the package runs under Node, Bun
 * and Electron, and the desktop's utility child must never pull `node:fs`
 * through this module. `nodeHostStateFs()` in `./host-state-node` is the one
 * adapter, exported on its own entry.
 */

export type HostScope = { revision: number; allowed_roots: string[]; visibility: "owner" | "org" }

export type HostState = {
  host_id: string
  private_key_jwk: JsonWebKey
  /**
   * The ECDH half of this machine's identity, minted on the first run that
   * needs it and declared on every beat. Separate from `private_key_jwk`
   * because Web Crypto will not derive bits with an ECDSA key; see
   * `./machine-seal`.
   */
  sealing_private_key_jwk?: JsonWebKey
  /**
   * The owner's provider configuration as the control plane sealed it, stored
   * verbatim. It is ciphertext for THIS machine's sealing key, so the file is
   * at rest exactly as the wire had it and no plaintext secret is ever
   * written. `sealed: null` is a revocation the machine has recorded, kept so
   * a restart states the revision it has rather than asking for the blob again.
   */
  provider_config?: { revision: number; sealed: string | null }
  created_at: number
  /** Frozen at first redeem; a different URL is a different host state. */
  control_plane_url: string
  /** Present from "key persisted" until "enrollment persisted + token removed". */
  bootstrap?: { invitation_id: string; token_file: string }
  enrollment?: {
    enrollment_id: string
    owner_display: string
    org_id: string
    enrolled_via: string
    enrolled_at: number
    key_version: number
  }
  relay?: { url: string; jwksUrl: string }
  authority?: { sessionAuthorityUrl: string }
  /** The control plane's scope as last delivered; applied before any assignment is validated. */
  scope?: HostScope
  /** `--root` values, kept apart from the control plane's scope. */
  cli_roots: string[]
  /**
   * Each declared root's canonical form as first resolved, keyed by the root
   * as the scope or `--root` names it. A root that later resolves elsewhere
   * is refused (`resolveRoots`) until the record is cleared.
   */
  roots_canonical?: Record<string, string>
  /** WORKSPACE_RUNTIME_WORKSPACES_DIR for this host's runtimes. */
  storage_root: string
  service?: { kind: "systemd-user" | "launchd"; unit: string; installed_at: number }
  run?: {
    pid: number
    started_at: number
    generation: number
    last_beat_ok_at?: number
    /** The `expires_at` the control plane issued on that beat, not a TTL assumed here. */
    lease_expires_at?: number
    last_beat_error?: string
    /** What the last successful beat acked, with whether its tunnel is open; what `claxedo status` lists. */
    served?: Array<{ workspace_id: string; revision: number; connected: boolean }>
  }
}

export type HostStateFs = {
  /** `null` when the file does not exist. */
  readFile: (path: string) => Promise<string | null>
  writeFile: (path: string, text: string, options: { mode: number }) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  mkdir: (path: string, options: { recursive: true; mode: number }) => Promise<void>
  /** Removing a file that is already gone succeeds. */
  unlink: (path: string) => Promise<void>
}

export const HOST_STATE_FILE_MODE = 0o600
export const HOST_STATE_DIR_MODE = 0o700

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stateFieldError(field: string, what: string): never {
  throw new Error(`host state: ${field} ${what}`)
}

function stateStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) stateFieldError(field, "must be a list of strings")
  const list: string[] = []
  for (const entry of value) {
    if (typeof entry !== "string") stateFieldError(field, "must be a list of strings")
    list.push(entry)
  }
  return list
}

function stateString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) stateFieldError(field, "missing")
  return value
}

function stateNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) stateFieldError(field, "missing")
  return value
}

function stateRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainRecord(value)) stateFieldError(field, "must be an object")
  return value
}

function stateStringOrUndefined(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function stateNumberOrUndefined(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** A control-plane URL this machine refuses to talk to; the operator has to change it. */
export class ControlPlaneUrlError extends Error {
  readonly url: string
  constructor(url: string, what: string) {
    super(`control plane ${url} ${what}`)
    this.name = "ControlPlaneUrlError"
    this.url = url
  }
}

/**
 * These three names and nothing else — not `*.localhost`, not the rest of
 * 127.0.0.0/8, not `0.0.0.0`. They are the hosts an `http:` request cannot
 * leave the machine for, which is the whole reason cleartext is allowed at
 * all; anything wider is a plaintext enrollment secret on a network.
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"])

/**
 * The origin (with an optional path prefix) that every machine request is
 * composed onto, or a refusal.
 *
 * Cleartext to a network host is refused because the invitation secret is in
 * the redeem body and the heartbeat answer — scope, assignments, relay
 * endpoints — is trusted by the host beyond the channel that carried it.
 *
 * A base carrying a query or a fragment is refused rather than trimmed:
 * `https://cp/?x=1` concatenated with `/api/...` is a request to `/` whose
 * query holds the route, and the machine signature covers the path — the two
 * would disagree about what was signed. Percent-encoding and empty segments
 * are refused for the same reason: the path has to mean one thing.
 */
export function canonicalControlPlaneUrl(value: string): string {
  const trimmed = value.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new ControlPlaneUrlError(value, "is not a URL")
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname))) {
    throw new ControlPlaneUrlError(value, "must be https:// (http:// only for localhost, 127.0.0.1 or ::1)")
  }
  if (url.username || url.password) throw new ControlPlaneUrlError(value, "must carry no user or password")
  if (trimmed.includes("?") || trimmed.includes("#")) throw new ControlPlaneUrlError(value, "must carry no query or fragment")
  const pathname = url.pathname.replace(/\/+$/, "")
  if (pathname !== "" && !/^(?:\/[^/%]+)+$/.test(pathname)) {
    throw new ControlPlaneUrlError(value, "must be an origin, optionally with a plain path prefix")
  }
  return url.origin + pathname
}

/** An endpoint a control-plane body delivered that this machine refuses to use; the refusal names the field. */
export class HostEndpointUrlError extends Error {
  readonly field: string
  readonly url: string
  constructor(field: string, url: string, what: string) {
    super(`${field} ${url} ${what}`)
    this.name = "HostEndpointUrlError"
    this.field = field
    this.url = url
  }
}

/**
 * The relay, JWKS and session-authority addresses arrive inside a signed
 * answer, but they are configuration, not proof: the consumer either dials
 * the address with the Host Tunnel Token in an `authorization` header or
 * fetches it for the key set and session decisions that gate relayed
 * callers. An arbitrary scheme (`file:`, `javascript:`) is refused outright,
 * credentials embedded in the URL would be sent or logged with it, and
 * cleartext gets the same loopback-only exception the control-plane base
 * has — a `ws:`/`http:` request to a network host hands the token, and the
 * answers it admits, to the wire.
 */
function hostEndpointUrl(
  value: string,
  field: string,
  secure: readonly string[],
  cleartext: readonly string[],
  expectation: string,
): string {
  const trimmed = value.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new HostEndpointUrlError(field, value, "is not a URL")
  }
  if (!secure.includes(url.protocol) && !(cleartext.includes(url.protocol) && LOOPBACK_HOSTNAMES.has(url.hostname))) {
    throw new HostEndpointUrlError(field, value, expectation)
  }
  if (url.username || url.password) throw new HostEndpointUrlError(field, value, "must carry no user or password")
  if (trimmed.includes("?") || trimmed.includes("#")) throw new HostEndpointUrlError(field, value, "must carry no query or fragment")
  return url.origin + url.pathname.replace(/\/+$/, "")
}

/**
 * The relay address a heartbeat or the `hostTunnel` credential delivers,
 * canonicalized or refused. The tunnel dials it as a WebSocket (http(s) is
 * converted to ws(s)), so both spellings name the same endpoint.
 */
export function canonicalRelayUrl(value: string, field = "relay.url"): string {
  return hostEndpointUrl(
    value,
    field,
    ["wss:", "https:"],
    ["ws:", "http:"],
    "must be wss:// or https:// (ws:// or http:// only for localhost, 127.0.0.1 or ::1)",
  )
}

/**
 * An endpoint a heartbeat delivers for this machine to FETCH — the relay's
 * JWKS, the session authority — canonicalized or refused.
 */
export function canonicalFetchEndpointUrl(value: string, field: string): string {
  return hostEndpointUrl(value, field, ["https:"], ["http:"], "must be https:// (http:// only for localhost, 127.0.0.1 or ::1)")
}

function privateKeyJwk(value: unknown, field = "private_key_jwk"): JsonWebKey {
  const jwk = stateRecord(value, field)
  return {
    kty: stateString(jwk.kty, `${field}.kty`),
    crv: stateString(jwk.crv, `${field}.crv`),
    x: stateString(jwk.x, `${field}.x`),
    y: stateString(jwk.y, `${field}.y`),
    d: stateString(jwk.d, `${field}.d`),
  }
}

function providerConfigRecord(value: unknown): NonNullable<HostState["provider_config"]> {
  const record = stateRecord(value, "provider_config")
  const sealed = record.sealed
  if (sealed !== null && (typeof sealed !== "string" || !sealed)) stateFieldError("provider_config.sealed", "must be a string or null")
  return { revision: stateNumber(record.revision, "provider_config.revision"), sealed }
}

function scopeRecord(value: unknown): HostScope {
  const record = stateRecord(value, "scope")
  return {
    revision: stateNumber(record.revision, "scope.revision"),
    allowed_roots: stateStrings(record.allowed_roots, "scope.allowed_roots"),
    visibility: record.visibility === "org" ? "org" : "owner",
  }
}

function runRecord(value: unknown): NonNullable<HostState["run"]> {
  const record = stateRecord(value, "run")
  const served = Array.isArray(record.served)
    ? record.served.filter(isPlainRecord).map((entry) => ({
        workspace_id: stateString(entry.workspace_id, "run.served.workspace_id"),
        revision: stateNumber(entry.revision, "run.served.revision"),
        connected: entry.connected === true,
      }))
    : undefined
  const lastBeatOkAt = stateNumberOrUndefined(record.last_beat_ok_at)
  const leaseExpiresAt = stateNumberOrUndefined(record.lease_expires_at)
  const lastBeatError = stateStringOrUndefined(record.last_beat_error)
  return {
    pid: stateNumber(record.pid, "run.pid"),
    started_at: stateNumber(record.started_at, "run.started_at"),
    generation: stateNumber(record.generation, "run.generation"),
    ...(lastBeatOkAt !== undefined ? { last_beat_ok_at: lastBeatOkAt } : {}),
    ...(leaseExpiresAt !== undefined ? { lease_expires_at: leaseExpiresAt } : {}),
    ...(lastBeatError !== undefined ? { last_beat_error: lastBeatError } : {}),
    ...(served ? { served } : {}),
  }
}

/**
 * The file is untrusted input like any other JSON on disk; every field is
 * read back through a check here, once, so a truncated or hand-edited file
 * fails with the field named rather than deep inside a signer.
 */
export function parseHostState(text: string): HostState {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`host state is not JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (!isPlainRecord(value)) throw new Error("host state must be a JSON object")
  const state: HostState = {
    host_id: stateString(value.host_id, "host_id"),
    private_key_jwk: privateKeyJwk(value.private_key_jwk),
    created_at: stateNumber(value.created_at, "created_at"),
    // Canonicalized on the way back in, not just on the way out: a file edited
    // to name an http:// control plane must not put this machine back on a
    // cleartext channel, whoever edited it.
    control_plane_url: canonicalControlPlaneUrl(stateString(value.control_plane_url, "control_plane_url")),
    cli_roots: stateStrings(value.cli_roots, "cli_roots"),
    storage_root: stateString(value.storage_root, "storage_root"),
  }
  if (value.bootstrap !== undefined) {
    const record = stateRecord(value.bootstrap, "bootstrap")
    state.bootstrap = {
      invitation_id: stateString(record.invitation_id, "bootstrap.invitation_id"),
      token_file: stateString(record.token_file, "bootstrap.token_file"),
    }
  }
  if (value.enrollment !== undefined) {
    const record = stateRecord(value.enrollment, "enrollment")
    state.enrollment = {
      enrollment_id: stateString(record.enrollment_id, "enrollment.enrollment_id"),
      owner_display: stateStringOrUndefined(record.owner_display) ?? "",
      org_id: stateStringOrUndefined(record.org_id) ?? "",
      enrolled_via: stateStringOrUndefined(record.enrolled_via) ?? "invitation",
      enrolled_at: stateNumberOrUndefined(record.enrolled_at) ?? 0,
      key_version: stateNumberOrUndefined(record.key_version) ?? 1,
    }
  }
  if (value.relay !== undefined) {
    const record = stateRecord(value.relay, "relay")
    // Re-validated on the way back in, like control_plane_url: a file edited
    // to name a cleartext or arbitrary-scheme endpoint must not put this
    // machine back on a channel the write-time checks refused.
    state.relay = {
      url: canonicalRelayUrl(stateString(record.url, "relay.url")),
      jwksUrl: canonicalFetchEndpointUrl(stateString(record.jwksUrl, "relay.jwksUrl"), "relay.jwksUrl"),
    }
  }
  if (value.authority !== undefined) {
    const record = stateRecord(value.authority, "authority")
    state.authority = {
      sessionAuthorityUrl: canonicalFetchEndpointUrl(
        stateString(record.sessionAuthorityUrl, "authority.sessionAuthorityUrl"),
        "authority.sessionAuthorityUrl",
      ),
    }
  }
  if (value.sealing_private_key_jwk !== undefined) {
    state.sealing_private_key_jwk = privateKeyJwk(value.sealing_private_key_jwk, "sealing_private_key_jwk")
  }
  if (value.provider_config !== undefined) state.provider_config = providerConfigRecord(value.provider_config)
  if (value.scope !== undefined) state.scope = scopeRecord(value.scope)
  if (value.roots_canonical !== undefined) {
    const record = stateRecord(value.roots_canonical, "roots_canonical")
    state.roots_canonical = Object.fromEntries(
      Object.entries(record).map(([root, canonical]) => [root, stateString(canonical, `roots_canonical[${root}]`)]),
    )
  }
  if (value.service !== undefined) {
    const record = stateRecord(value.service, "service")
    state.service = {
      kind: record.kind === "launchd" ? "launchd" : "systemd-user",
      unit: stateString(record.unit, "service.unit"),
      installed_at: stateNumber(record.installed_at, "service.installed_at"),
    }
  }
  if (value.run !== undefined) state.run = runRecord(value.run)
  return state
}

export function serializeHostState(state: HostState) {
  return JSON.stringify(state, null, 2) + "\n"
}

function parentDirectory(file: string) {
  const cut = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"))
  return cut > 0 ? file.slice(0, cut) : undefined
}

export type HostStateStore = ReturnType<typeof createHostStateStore>

export function createHostStateStore(options: { file: string; fs: HostStateFs; random?: () => string }) {
  const random = options.random ?? (() => crypto.randomUUID())
  return {
    file: options.file,
    fs: options.fs,
    async load(): Promise<HostState | undefined> {
      const text = await options.fs.readFile(options.file)
      return text === null ? undefined : parseHostState(text)
    },
    /**
     * Write to a sibling temp file and rename over the target, so a crash mid
     * write leaves either the previous state or the new one, never a torn
     * file that the next boot parses as "no key" and mints a fresh identity.
     */
    async save(state: HostState): Promise<void> {
      const directory = parentDirectory(options.file)
      if (directory) await options.fs.mkdir(directory, { recursive: true, mode: HOST_STATE_DIR_MODE })
      const temp = `${options.file}.${random()}.tmp`
      try {
        await options.fs.writeFile(temp, serializeHostState(state), { mode: HOST_STATE_FILE_MODE })
        await options.fs.rename(temp, options.file)
      } catch (error) {
        await options.fs.unlink(temp).catch(() => undefined)
        throw error
      }
    },
    /**
     * A boot that finds `bootstrap` still set beside an enrollment was
     * interrupted between "enrollment persisted" and "token removed": finish
     * that first, so the invitation file does not outlive the enrollment it
     * created. `bootstrap` without an enrollment is a redeem that never got
     * its answer and is the caller's to retry.
     */
    async finishPendingCleanup(state: HostState): Promise<HostState> {
      if (!state.bootstrap || !state.enrollment) return state
      await options.fs.unlink(state.bootstrap.token_file)
      const { bootstrap: _pending, ...cleaned } = state
      await this.save(cleaned)
      return cleaned
    },
  }
}

export function newHostState(input: {
  hostId: string
  privateKeyJwk: JsonWebKey
  controlPlaneUrl: string
  cliRoots: readonly string[]
  storageRoot: string
  now?: () => number
}): HostState {
  return {
    host_id: input.hostId,
    // Only the five fields the key is rebuilt from; `key_ops`/`ext` from the
    // exporting runtime would otherwise round-trip through the file for nothing.
    private_key_jwk: privateKeyJwk(input.privateKeyJwk),
    created_at: (input.now ?? Date.now)(),
    control_plane_url: canonicalControlPlaneUrl(input.controlPlaneUrl),
    cli_roots: [...input.cliRoots],
    storage_root: input.storageRoot,
  }
}

/**
 * Collapse `.`/`..` and trailing slashes on an absolute POSIX path; anything
 * else answers `undefined` and is refused by every caller.
 */
export function normalizeAbsolutePath(path: string): string | undefined {
  if (!path.startsWith("/")) return undefined
  const segments: string[] = []
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return "/" + segments.join("/")
}

/** Segment-aware containment: `/srv/api` is under `/srv`; `/srvx` is not. */
export function pathWithin(path: string, root: string) {
  const inner = normalizeAbsolutePath(path)
  const outer = normalizeAbsolutePath(root)
  if (inner === undefined || outer === undefined) return false
  if (outer === "/") return true
  return inner === outer || inner.startsWith(outer + "/")
}

export function pathWithinRoots(path: string, roots: readonly string[]) {
  return roots.some((root) => pathWithin(path, root))
}

export type ResolvePath = (path: string) => Promise<string>

/**
 * A root in the same coordinate space the assignment directories are checked
 * in: `resolve` (realpath) of the root itself, or, for a root that does not
 * exist yet, of its nearest existing ancestor with the remaining segments
 * appended. A symlinked ancestor therefore lands the root where the link
 * points, the same place a directory created under it later resolves to.
 * Nothing resolvable at all (not even `/`) drops the root.
 */
export async function canonicalRoot(root: string, resolve: ResolvePath): Promise<string | undefined> {
  const normalized = normalizeAbsolutePath(root)
  if (normalized === undefined) return undefined
  let head = normalized
  const tail: string[] = []
  for (;;) {
    let resolved: string | undefined
    try {
      resolved = await resolve(head)
    } catch {
      if (head === "/") return undefined
      const cut = head.lastIndexOf("/")
      tail.unshift(head.slice(cut + 1))
      head = cut === 0 ? "/" : head.slice(0, cut)
      continue
    }
    return normalizeAbsolutePath([resolved, ...tail].join("/"))
  }
}

export type RootDrift = { root: string; recorded: string; resolved: string }

export type ResolvedRoots = {
  /** The effective roots, drifted ones excluded. */
  roots: string[]
  /** The record as it stands after this resolution: every declared root's first canonical form. */
  canonical: Record<string, string>
  /** Declared roots refused because they no longer resolve where they were first recorded. */
  drifted: RootDrift[]
}

type RootRecord = { canonical: Record<string, string>; drifted: RootDrift[] }

/**
 * Resolve each root, pinning it to its first canonical form. A root that
 * did not exist when first resolved was pinned lexically; if it is later
 * created as a symlink, its canonical form moves and every directory under
 * it would resolve inside the link's target — so a moved root serves
 * nothing until the operator clears the record.
 */
async function canonicalRoots(roots: readonly string[], resolve: ResolvePath, recorded: Record<string, string>, record: RootRecord) {
  const kept: string[] = []
  for (const root of roots) {
    const resolved = await canonicalRoot(root, resolve)
    if (resolved === undefined) continue
    const pinned = recorded[root]
    if (pinned !== undefined && pinned !== resolved) {
      record.canonical[root] = pinned
      record.drifted.push({ root, recorded: pinned, resolved })
      continue
    }
    record.canonical[root] = resolved
    kept.push(resolved)
  }
  return kept
}

/**
 * CP `allowed_roots` ∩ `cli_roots` by containment, each side resolved and
 * pinned first: a cli root inside a CP root narrows to the cli root, a CP
 * root inside a cli root keeps the CP root, disjoint pairs contribute
 * nothing. Resolving before intersecting is what stops a cli root that is a
 * symlink under a CP root from carrying the CP root's authority to wherever
 * the link points. No cli roots ⇒ the CP roots. No scope yet, or an EMPTY
 * `allowed_roots` ⇒ nothing is servable — "unrestricted" is never an answer
 * this function gives.
 */
export async function resolveRoots(
  state: Pick<HostState, "scope" | "cli_roots" | "roots_canonical">,
  resolve: ResolvePath,
): Promise<ResolvedRoots> {
  const recorded = state.roots_canonical ?? {}
  const record: RootRecord = { canonical: {}, drifted: [] }
  const controlPlane = await canonicalRoots(state.scope?.allowed_roots ?? [], resolve, recorded, record)
  const cli = await canonicalRoots(state.cli_roots, resolve, recorded, record)
  const roots = new Set<string>()
  if (controlPlane.length > 0 && state.cli_roots.length === 0) {
    for (const root of controlPlane) roots.add(root)
  } else {
    for (const local of cli) {
      for (const remote of controlPlane) {
        if (pathWithin(local, remote)) roots.add(local)
        else if (pathWithin(remote, local)) roots.add(remote)
      }
    }
  }
  return { roots: [...roots].sort(), ...record }
}

export async function effectiveRoots(state: Pick<HostState, "scope" | "cli_roots" | "roots_canonical">, resolve: ResolvePath): Promise<string[]> {
  return (await resolveRoots(state, resolve)).roots
}

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

function privateKeyJwk(value: unknown): JsonWebKey {
  const jwk = stateRecord(value, "private_key_jwk")
  return {
    kty: stateString(jwk.kty, "private_key_jwk.kty"),
    crv: stateString(jwk.crv, "private_key_jwk.crv"),
    x: stateString(jwk.x, "private_key_jwk.x"),
    y: stateString(jwk.y, "private_key_jwk.y"),
    d: stateString(jwk.d, "private_key_jwk.d"),
  }
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
    control_plane_url: stateString(value.control_plane_url, "control_plane_url"),
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
    state.relay = { url: stateString(record.url, "relay.url"), jwksUrl: stateString(record.jwksUrl, "relay.jwksUrl") }
  }
  if (value.authority !== undefined) {
    const record = stateRecord(value.authority, "authority")
    state.authority = { sessionAuthorityUrl: stateString(record.sessionAuthorityUrl, "authority.sessionAuthorityUrl") }
  }
  if (value.scope !== undefined) state.scope = scopeRecord(value.scope)
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
    control_plane_url: input.controlPlaneUrl,
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

/**
 * CP `allowed_roots` ∩ `cli_roots` by containment: a cli root inside a CP root
 * narrows to the cli root, a CP root inside a cli root keeps the CP root,
 * disjoint pairs contribute nothing. No cli roots ⇒ the CP roots. No scope
 * yet, or an EMPTY `allowed_roots` ⇒ nothing is servable — "unrestricted" is
 * never an answer this function gives.
 */
export function effectiveRoots(state: Pick<HostState, "scope" | "cli_roots">): string[] {
  const controlPlane = (state.scope?.allowed_roots ?? [])
    .map(normalizeAbsolutePath)
    .filter((root): root is string => root !== undefined)
  if (controlPlane.length === 0) return []
  if (state.cli_roots.length === 0) return [...new Set(controlPlane)].sort()
  const cli = state.cli_roots.map(normalizeAbsolutePath).filter((root): root is string => root !== undefined)
  const roots = new Set<string>()
  for (const local of cli) {
    for (const remote of controlPlane) {
      if (pathWithin(local, remote)) roots.add(local)
      else if (pathWithin(remote, local)) roots.add(remote)
    }
  }
  return [...roots].sort()
}

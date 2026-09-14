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
    last_beat_error?: string
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

function requireStringList(value: unknown, field: string) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`host state: ${field} must be a list of strings`)
  }
  return value as string[]
}

/**
 * The file is untrusted input like any other JSON on disk; the fields the
 * connector cannot run without are checked here, once, so a truncated or
 * hand-edited file fails with the file named rather than deep inside a signer.
 */
export function parseHostState(text: string): HostState {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`host state is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isPlainRecord(value)) throw new Error("host state must be a JSON object")
  if (typeof value.host_id !== "string" || !value.host_id) throw new Error("host state: host_id missing")
  if (!isPlainRecord(value.private_key_jwk) || typeof value.private_key_jwk.d !== "string") {
    throw new Error("host state: private_key_jwk missing")
  }
  if (typeof value.control_plane_url !== "string" || !value.control_plane_url) {
    throw new Error("host state: control_plane_url missing")
  }
  if (typeof value.created_at !== "number") throw new Error("host state: created_at missing")
  if (typeof value.storage_root !== "string" || !value.storage_root) throw new Error("host state: storage_root missing")
  requireStringList(value.cli_roots, "cli_roots")
  if (value.scope !== undefined) {
    if (!isPlainRecord(value.scope) || typeof value.scope.revision !== "number") {
      throw new Error("host state: scope.revision missing")
    }
    requireStringList(value.scope.allowed_roots, "scope.allowed_roots")
  }
  if (value.enrollment !== undefined) {
    if (!isPlainRecord(value.enrollment) || typeof value.enrollment.enrollment_id !== "string") {
      throw new Error("host state: enrollment.enrollment_id missing")
    }
  }
  if (value.bootstrap !== undefined) {
    if (
      !isPlainRecord(value.bootstrap) ||
      typeof value.bootstrap.invitation_id !== "string" ||
      typeof value.bootstrap.token_file !== "string"
    ) {
      throw new Error("host state: bootstrap must name invitation_id and token_file")
    }
  }
  return value as HostState
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
    private_key_jwk: input.privateKeyJwk,
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

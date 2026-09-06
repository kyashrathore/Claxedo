/**
 * Opaque authorized workspace scope.
 *
 * Why this exists, concretely: the pinned SDK performs NO location
 * authorization. `sessions.get({ sessionID })` returns any session to any
 * caller, including the owning workspace's directory
 * (docs/architecture/opencode-embedded-sdk-contract.md §4, asserted in the
 * contract probe). One process shares one host across every local workspace,
 * so Claxedo's scope check is the ONLY barrier between workspaces — not
 * defence-in-depth.
 *
 * Two rules follow, and both are enforced by construction rather than by
 * convention:
 *
 *   1. Runtime-port methods never accept a caller-supplied directory. They
 *      accept a scope that outer route authorization already minted.
 *   2. A scope is re-validated against the real filesystem on mint, so a
 *      symlink retarget or workspace move cannot silently widen access.
 */
import * as fs from "node:fs"
import * as path from "node:path"

export class WorkspaceScopeError extends Error {
  readonly code = "opencode_workspace_scope_invalid"
  constructor(message: string) {
    super(message)
    this.name = "WorkspaceScopeError"
  }
}

/**
 * An authorized workspace.
 *
 * Unforgeable by construction: the constructor is private, so the only value
 * of this type is one `authorize` produced after running the checks below, and
 * the private field makes the class nominal so an object literal with the same
 * two fields is not a `WorkspaceScope`. "Where may this operation act?"
 * therefore always traces back to an `authorize` call that did the work.
 */
export class WorkspaceScope {
  /**
   * Nominal brand. Never read: a class whose members are all public is
   * structurally identical to `{ workspaceID, directory }`, and a caller could
   * then hand a bare object to any port that takes a scope.
   */
  private readonly authorized = true

  private constructor(
    /** Canonical Claxedo workspace identity. */
    readonly workspaceID: string,
    /** Fully resolved real path — symlinks followed. */
    readonly directory: string,
  ) {}

  /**
   * Mint a scope from a canonical workspace identity and directory.
   *
   * Call this ONLY from a composition/route boundary that has already decided
   * the actor may act on this workspace. Resolving the real path here is what
   * makes a later `sameScope` check meaningful after a symlink change.
   */
  static authorize(input: { workspaceID: string; directory: string }): WorkspaceScope {
    const workspaceID = input.workspaceID.trim()
    if (!workspaceID) throw new WorkspaceScopeError("A workspace scope requires a canonical workspace id")

    if (!path.isAbsolute(input.directory)) {
      throw new WorkspaceScopeError(`Workspace directory must be absolute, received ${input.directory}`)
    }

    let directory: string
    try {
      directory = fs.realpathSync(input.directory)
    } catch (cause) {
      throw new WorkspaceScopeError(
        `Workspace directory ${input.directory} could not be resolved: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }

    if (!fs.statSync(directory).isDirectory()) {
      throw new WorkspaceScopeError(`Workspace path ${directory} is not a directory`)
    }

    return new WorkspaceScope(workspaceID, directory)
  }
}

/** True when two scopes name the same authorized workspace. */
export function sameScope(a: WorkspaceScope, b: WorkspaceScope): boolean {
  return a.workspaceID === b.workspaceID && a.directory === b.directory
}

/**
 * Assert that a location reported by the SDK belongs to the scope the caller
 * was authorized for.
 *
 * Every read that returns a location must pass through here. `sessions.get`
 * happily returns another workspace's session, so a projection that trusted
 * the SDK's answer would leak across workspaces.
 */
export function assertLocationInScope(scope: WorkspaceScope, directory: string | undefined): void {
  if (!directory) {
    throw new WorkspaceScopeError("OpenCode returned a record with no location; refusing to attribute it to a workspace")
  }
  let resolved: string
  try {
    resolved = fs.realpathSync(directory)
  } catch {
    resolved = path.resolve(directory)
  }
  if (resolved !== scope.directory) {
    throw new WorkspaceScopeError("OpenCode record belongs to a different workspace than the authorized scope")
  }
}

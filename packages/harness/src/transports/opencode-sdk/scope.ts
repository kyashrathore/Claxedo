import * as fs from "node:fs"
import * as path from "node:path"

export class WorkspaceScopeError extends Error {
  readonly code = "opencode_workspace_scope_invalid"
  constructor(message: string) {
    super(message)
    this.name = "WorkspaceScopeError"
  }
}

export class WorkspaceScope {
  
  private readonly authorized = true

  private constructor(
    
    readonly workspaceID: string,
    
    readonly directory: string,
  ) {}

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

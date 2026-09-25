import * as fs from "node:fs"
import * as path from "node:path"
import { realPathAllowingMissing } from "@claxedo/helpers/real-path"
import { errorMessage } from "@claxedo/helpers"

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
      directory = realPathAllowingMissing(input.directory)
    } catch (cause) {
      throw new WorkspaceScopeError(
        `Workspace directory ${input.directory} could not be resolved: ${errorMessage(cause)}`,
      )
    }

    let isDirectory: boolean
    try { isDirectory = fs.statSync(directory).isDirectory() }
    catch (cause) { throw new WorkspaceScopeError(`Workspace directory ${input.directory} could not be resolved: ${errorMessage(cause)}`) }
    if (!isDirectory) {
      throw new WorkspaceScopeError(`Workspace path ${directory} is not a directory`)
    }

    return new WorkspaceScope(workspaceID, directory)
  }
}

export function sameScope(a: WorkspaceScope, b: WorkspaceScope): boolean {
  return a.workspaceID === b.workspaceID && a.directory === b.directory
}

export function assertLocationInScope(scope: WorkspaceScope, directory: string | undefined): void {
  if (!directory) {
    throw new WorkspaceScopeError("OpenCode returned a record with no location; refusing to attribute it to a workspace")
  }
  const resolved = realPathAllowingMissing(directory)
  if (resolved !== scope.directory) {
    throw new WorkspaceScopeError("OpenCode record belongs to a different workspace than the authorized scope")
  }
}

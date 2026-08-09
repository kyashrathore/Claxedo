// CONTRACT BINDING: GET /api/workspace/resolve
//
// This binding calls the real server's response producer. It deliberately does
// not maintain a second field table in the e2e package: adding, removing, or
// renaming a field in the route projection changes the mock response on the same
// build.
import type { Workspace } from "../../../../claxedo-server-core/src/workspace/store/index"
import {
  workspaceResponse,
  type WorkspaceResponse,
} from "../../../../claxedo-server/src/workspace/workspace-response"

export function workspaceResolveResponse(workspace: Workspace): WorkspaceResponse {
  const response = workspaceResponse(workspace)
  if (!response) throw new Error(`workspace resolve contract produced no response for ${workspace.id}`)
  return response
}

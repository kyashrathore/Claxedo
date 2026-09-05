import type { WorkspaceRuntimeManagementAuth } from "./management-auth"

export { openCodePartId } from "./opencode/session-port"

export {
  createOpenCodeFixtureIds,
  importOpenCodeFixtureSessions,
  type OpenCodeFixtureSession,
  type OpenCodeFixtureReadback,
} from "./opencode/fixtures"

export function allowWorkspaceRuntimeManagementAuth(subject = "test"): WorkspaceRuntimeManagementAuth {
  return {
    async authorize() {
      return { ok: true, subject, scopes: ["runtime.config.apply"] }
    },
  }
}

export function denyWorkspaceRuntimeManagementAuth(status: 401 | 403 = 401): WorkspaceRuntimeManagementAuth {
  return {
    async authorize() {
      return {
        ok: false,
        status,
        code: status === 401 ? "unauthorized" : "forbidden",
        message: status === 401 ? "Unauthorized" : "Forbidden",
      }
    },
  }
}
